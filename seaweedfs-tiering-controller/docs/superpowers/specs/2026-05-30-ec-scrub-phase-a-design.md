# EC 巡检 Phase A — 按需 ec.scrub 端点 + UI — 设计 (Spec)

**日期:** 2026-05-30
**状态:** 已批准设计,待写实现计划
**类型:** 全栈(Go SSE 端点 + Next.js EC 页面)
**所属:** EC 巡检能力的 Phase A(B = 定时巡检 + 持久化 + 告警,后续单独 spec)

## 目标 (Goal)

在 EC shards 页提供按需 EC 完整性巡检:选择 mode(index/local/full)后流式运行 `weed shell ec.scrub`,实时显示逐节点进度,结束时给出结构化汇总(损坏的 EC 卷/分片数 + 受影响列表)。

## 背景

- 平台已能看到 EC **分片缺失**(`ECPotentiallyShortShards`、ec-shards 页:实际数量 < 预期),但**看不到"分片在、内容已损坏"**(bit rot / 坏扇区 / 静默损坏)。`ec.scrub` 是唯一能主动读出并校验 EC 分片内容的手段;修复侧已有 `ec.rebuild`,本特性补"检测"。
- `ec.scrub` 命令(`weed/shell/command_ec_scrub.go`):`ec.scrub [-node h:p,...] [-volumeId id,...] [-mode index|local|full] [-maxParallelization N]`。**只读**(校验、不改数据),但持集群锁、可慢(full 读文件内容)。默认全节点 + 全 EC 卷。
  - 逐节点打印 `Scrubbing <addr> (i/N)...` 和 `using <MODE> mode`。
  - 末尾:`Scrubbed F EC files and V volumes on N nodes`;若有损坏:`Got scrub failures on X EC volumes and Y EC shards :(`、`Affected volumes: addr:vid, ...`、`Affected shards:  addr:vid:sid, ...`、`Details:` 多行。
- 平台已有成熟的 SSE 流式 shell 模式:`streamWithHeartbeat(c, started, func(emit, lineSink){...})`(`ec_ops.go`),逐行 `line` 事件 + `start`/`done`,tee 输出到 buffer 末尾解析(见 `volumeBalanceStream`/`ecEncodeStream`)。前端已有消费这些流的方式(EC encode/balance UI)。

## 设计决策(已确认)

1. **范围**:整集群巡检(全节点 + 全 EC 卷)+ mode 选择(index/local/full,默认 local);**不**做 per-volume/node 过滤、不暴露 maxParallelization(YAGNI;B 或后续再加)。
2. **cap `volume.read`**(只读诊断,与 ec.rebuild dry-run 一致),**不接安全 Guard**(只读)。
3. **入口** EC shards 页(`/clusters/:id/ec-shards`),SSE 流式日志 + 末尾结构化汇总。
4. 不持久化、不调度、不告警(那是 Phase B)。

## 架构与组件

### 后端 — 新文件 `internal/api/cluster_ec_scrub.go`

**纯函数(可单测):**
```go
type ecScrubSummary struct {
	BrokenVolumes   int      `json:"broken_volumes"`
	BrokenShards    int      `json:"broken_shards"`
	AffectedVolumes []string `json:"affected_volumes"`
	AffectedShards  []string `json:"affected_shards"`
}

// parseECScrubOutput parses the scrub command's trailing summary lines.
// No "Got scrub failures" line → zero broken, empty lists.
func parseECScrubOutput(raw string) ecScrubSummary
```
解析规则:
- `Got scrub failures on (\d+) EC volumes and (\d+) EC shards` → `BrokenVolumes`/`BrokenShards`(无此行 → 0/0)。
- `Affected volumes:` 后逗号分隔项 → `AffectedVolumes`(trim)。
- `Affected shards:` 后逗号分隔项 → `AffectedShards`(trim)。
- **核心只取 broken 汇总**(上面 4 个字段);不解析 `Scrubbed F EC files...` 那行的 scrubbed 总数(YAGNI —— 那行原文仍在流式日志里可见,无需结构化)。

**mode 校验(纯/小函数):**
```go
// validateScrubMode normalizes/validates the mode; default "local".
func validateScrubMode(mode string) (string, error) // returns "index"|"local"|"full" or error
```

**SSE handler:**
```go
// ecScrubStream runs `weed shell ec.scrub` over the whole cluster and
// streams progress; the final `done` event carries the parsed broken
// volumes/shards summary. Read-only (cap volume.read); not Guard-gated.
//
// POST /api/v1/clusters/:id/ec/scrub   body: {"mode":"index|local|full"}
func ecScrubStream(d Deps) gin.HandlerFunc
```
- 解析 `:id` → 400 bad uuid。
- bind body `{Mode string}`;`validateScrubMode` → 400 非法。
- `GetCluster` → 404。
- SSE 头 + `streamWithHeartbeat`:`start` 事件带 `{mode, command:"ec.scrub", started_at}`;`sink` tee 到 `strings.Builder` + `lineSink`;`RunShellCommandAtWithBin(ctx, cl.MasterAddr, cl.WeedBinPath, "ec.scrub", []string{"-mode="+mode}, sink)`;超时 `2h`(full 可能很慢)。
- `done` 事件带 `{ok, error, duration_ms, summary: parseECScrubOutput(buf)}`。
- 流结束后 audit `ec.scrub`,ctx `{mode, ok, broken_volumes, broken_shards}`。

**路由(`server.go`):** `v1.POST("/clusters/:id/ec/scrub", auth.RequireCap(d.Caps, "volume.read"), ecScrubStream(d))`,放在现有 EC 路由块(`/clusters/:id/ec/...`)。

### 前端

**`web/lib/api.ts`:** 沿用现有 EC stream 客户端方式(EventSource 或 fetch-stream,与 `ecEncodeStream`/`volumeBalanceStream` 前端消费一致)。新增类型 `ECScrubSummary { broken_volumes; broken_shards; affected_volumes: string[]; affected_shards: string[] }`,以及一个开流函数(或复用现有通用 SSE 消费 hook,传 `POST /clusters/:id/ec/scrub` + `{mode}`)。**实现时先看 EC encode/balance 前端怎么开流消费,照搬。**

**`web/app/clusters/[id]/ec-shards/page.tsx`:** 新增「EC 巡检」卡片:
- mode 下拉(index / local / full,默认 local)+「开始巡检」按钮(进行中 spinner、disabled)。
- 开 SSE → 实时日志 tail(等宽、可滚动,复用现有流式日志展示)。
- 结束 → 汇总卡片:`broken_volumes==0` → 绿色「全部完好」;否则红色,显示 broken 卷/分片数 + 受影响卷/分片列表。
- cap 门控:无 `volume.read`(其实页面已要求 volume.read 才可见,故按钮默认可用)。
- i18n zh keys。

## 数据流

选 mode → 点「开始巡检」→ `POST /clusters/:id/ec/scrub {mode}` 开 SSE → 后端逐节点 scrub,逐行回流 → 前端 tail 日志 → `done` 带结构化汇总 → 前端渲染绿/红汇总卡片。无持久化。

## 错误处理

- bad uuid → 400;mode 非法 → 400;cluster 不存在 → 404。
- 命令失败 → `done` 事件 `ok:false` + error;前端红色错误提示(日志仍展示已收到的行)。
- 解析:无 "Got scrub failures" 行 → broken=0 → 绿色"全部完好"。
- scrub 持集群锁:运行期间其他 shell 操作会等锁 —— 这是命令固有行为,UI 文案提示"巡检中会占用集群 shell 锁"。

## 测试策略

- **后端**:`parseECScrubOutput` 表驱动单测(有失败输出含 Affected 列表 / 无失败输出 / 空字符串);`validateScrubMode`(index/local/full/默认/非法)。本机 Go 1.25 可 `go test`。SSE/runner 靠 `go build` + 手测。
- **前端**:`npm run typecheck` 改动文件不新增错误;手测三种 mode 巡检流 + 绿/红汇总 + 无权限隐藏。

## 范围外 (YAGNI / Phase B)

- 定时调度、结果持久化(表)、发现损坏发 `InsertAlertEvent` 告警 —— **Phase B**。
- per-node / per-volume 过滤、maxParallelization 暴露、单卷行内"巡检"动作。
- 自动触发 `ec.rebuild` 修复(检测与修复解耦;修复仍走现有 rebuild)。

## 受影响文件清单

新建 2(+本 spec):`internal/api/cluster_ec_scrub.go`、`internal/api/cluster_ec_scrub_test.go`。
修改 4:`internal/api/server.go`(路由)、`web/lib/api.ts`(类型 + 开流)、`web/app/clusters/[id]/ec-shards/page.tsx`(巡检卡片)、`web/lib/i18n.ts`(zh keys)。
