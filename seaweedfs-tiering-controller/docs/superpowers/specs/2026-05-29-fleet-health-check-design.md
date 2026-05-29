# 舰队批量健康探活(手动) — 设计 (Spec)

**日期:** 2026-05-29
**状态:** 已批准设计,待写实现计划
**类型:** 全栈(Go 后端新端点 + Next.js 前端按钮/徽章)

## 目标 (Goal)

在集群列表页提供一个「检查全部」按钮:点击后服务端并发探测所有集群,每个集群返回一个分层健康判级(绿/黄/红 + 原因),让运维一键验证整个舰队是否正常。

## 背景

平台已有的可复用构件:
- `(*seaweed.Client) ProbeMaster(master string) error`(`internal/seaweed/preflight.go:66`)—— master HTTP+gRPC 可达性探测,seaweed 包内 ~3s 缓存。
- `(*seaweed.Client) FetchMasterRaftServers(ctx, addr) ([]MasterRaftServer, time.Duration, error)`(`client.go:234`)—— raft 成员列表(含 `IsLeader`、`Suffrage`)。
- `(*seaweed.Client) ListFilers(ctx, masterAddr) ([]FilerNode, error)`(`client.go:124`)+ `probeFilerStatus(ctx, addr) (time.Duration, error)`(`cluster_filers.go:158`)—— filer 列表 + 单 filer `/status` 探测。
- `computeReplicationHealth(ctx, d, cl) (replicationHealthResp, error)`(`replication_health.go:70`)—— 副本/错放/欠副本健康(走拓扑缓存)。
- 现有 `GET /clusters/:id/health` 仅做浅层 `ProbeMaster`(单集群)。
- 前端 `useClusters()` SWR hook(`api.ts:822`);集群列表页 `web/app/clusters/page.tsx`(每行已有 enabled/disabled 徽章,无实时健康)。

现有单集群 `/health` 不够:运维要的是**一次性、全舰队**的健康快照,且要比"master 连得上"更深一层(quorum / filer / 副本)。

## 设计决策

1. **分层检查**:每集群聚合 4 个信号为单一状态(取最差)。
2. **入口**:`/clusters` 列表页「检查全部」按钮 + 每行徽章 + 顶部汇总。**手动**触发。
3. **结果临时**:不持久化、不定时自动探活(YAGNI)。
4. **服务端批量端点**(非前端 N 次 fan-out):一次请求,服务端 errgroup 并发 + 限流 + 每集群超时。
5. **复用 `cluster.read` cap**(只读诊断),不接安全 Guard,不新增 cap。

## 健康分层与判级

每个集群并行探测,聚合为单一 `status ∈ {green, yellow, red}`(取最差信号):

| 信号 key | 采集 | 判级 |
|---------|------|------|
| `master` | `ProbeMaster(cl.MasterAddr)` | 不可达 → **red** |
| `quorum` | `FetchMasterRaftServers(ctx, cl.MasterAddr)`:存在 `IsLeader==true` 的成员,且 voter 数 ≥ 多数(`votersWithLeader > len(voters)/2`) | 无 leader 或失去多数 → **red** |
| `filers` | `ListFilers` → 并发 `probeFilerStatus` 每个 filer | 有 filer 不可达 → **yellow**;无 filer 注册 → `unknown`(yellow,注明) |
| `replication` | `computeReplicationHealth(ctx, d, cl)`:欠副本/错放/peer 分歧汇总 | 有副本问题 → **yellow** |

判级规则:
- **green**:master 可达 + quorum 健康 + filer 全可达 + 无副本问题。
- **yellow**:可达但有降级(filer 部分不可达 / 副本问题 / 某信号 `unknown`)。
- **red**:`master` 不可达 **或** `quorum` 丢失。
- **unknown 处理**:任一信号采集超时/出错 → 该信号 `status=unknown, detail="<原因>"`,**不**拖垮整集群;集群整体若无 red 信号则记 **yellow** 并在 `reasons` 注明该信号未知。

`disabled` 的集群(`cl.enabled == false`):跳过探测,`status="skipped"`(灰),不计入绿/黄/红汇总。

## 架构与组件

### 后端 — 新文件 `internal/api/cluster_health_check.go`

**纯函数(可单测):**
```go
type signalStatus = string // "ok" | "warn" | "down" | "unknown"

type healthSignal struct {
	Key    string `json:"key"`    // master | quorum | filers | replication
	Status string `json:"status"` // ok|warn|down|unknown
	Detail string `json:"detail,omitempty"`
}

// rollupClusterStatus aggregates signals to green/yellow/red:
//   any "down" → "red"; else any "warn"/"unknown" → "yellow"; else "green".
func rollupClusterStatus(signals []healthSignal) string
```

**采集(每集群,带整体 deadline ~8s):**
```go
func gatherClusterHealth(ctx context.Context, d Deps, cl *store.Cluster) clusterHealthResult
```
- 顺序:先 `master`(ProbeMaster)。若 down,短路其余信号为 `unknown`(主不可达时探 filer/副本无意义),整体 red。
- 若 master ok:并行采 `quorum`/`filers`/`replication`,各自 best-effort,自身错误→该信号 `down`/`warn`/`unknown`(按表),绝不 panic/整体失败。
- 组装 `reasons`(非 ok 信号的人类可读汇总)。

**Handler:**
```go
// POST /api/v1/clusters/health-check  (cap: cluster.read)
func fleetHealthCheck(d Deps) gin.HandlerFunc
```
- 取集群列表(`d.PG.ListClusters` 或现有列表方法 —— 实现时确认方法名)。
- `errgroup` + 信号量(并发上限常量 `fleetHealthConcurrency = 8`)fan-out `gatherClusterHealth`,每集群子 ctx `context.WithTimeout(ctx, 8s)`。
- `disabled` 集群直接产出 `status="skipped"`,不探测。
- 返回:
```json
{
  "results": [{"cluster_id","name","enabled","status","reachable","latency_ms","signals":[{"key","status","detail"}],"reasons":[]}],
  "summary": {"green":N,"yellow":N,"red":N,"skipped":N,"total":N}
}
```
- 仅请求级错误(取列表失败)返回非 200。

**路由(`server.go`):** `v1.POST("/clusters/health-check", auth.RequireCap(d.Caps, "cluster.read"), fleetHealthCheck(d))`。放在集群级路由块靠前处。注意路径 `/clusters/health-check` 不能与 `/clusters/:id` 冲突 —— gin 中静态段优先于 `:id`,但需确认注册顺序/无 panic;若冲突,改用 `/clusters/health/check-all` 这类不与 `:id` 同级歧义的路径(实现时验证 gin 路由不 panic)。

### 前端

**`web/lib/api.ts`:**
- 类型 `FleetHealthResult { cluster_id; name; enabled; status: "green"|"yellow"|"red"|"skipped"; reachable: boolean; latency_ms: number; signals: {key:string; status:string; detail?:string}[]; reasons: string[] }` 和 `FleetHealthResponse { results: FleetHealthResult[]; summary: {green;yellow;red;skipped;total:number} }`。
- `api.fleetHealthCheck()` → `jpost(\`${BASE}/clusters/health-check\`, {})` as `Promise<FleetHealthResponse>`。

**`web/app/clusters/page.tsx`:**
- 顶部加「检查全部」按钮(进行中 `Loader2` spinner、`disabled`)。点击 → `api.fleetHealthCheck()` → 临时 `useState`(`results` Map by cluster_id + `summary`),**非 SWR**。
- 顶部汇总条:`{green} 健康 / {yellow} 警告 / {red} 异常 / {skipped} 跳过`(复用 stat/`HealthBadge` 风格)。
- 每行加健康列:绿/黄/红/灰徽章(复用 `HealthBadge` tone),点击/悬停展开看 `reasons` + 各 `signals` 明细。检查未运行时显示 "—"。
- i18n zh keys。

## 数据流

点「检查全部」→ `POST /clusters/health-check` → 服务端并发 `gatherClusterHealth` 每集群 → 聚合 → 一次返回 → 前端临时存 + 渲染徽章/汇总。无持久化、无后台任务。

## 错误处理

- 单集群:每 goroutine 捕获自身错误,失败/超时 → 该集群 red/yellow + reason,**不影响**其他集群。
- 信号级:best-effort,失败→ `unknown`/`down`(按表),绝不整体 500。
- 端点级:仅"取集群列表失败"返回 500。
- 前端:`api.fleetHealthCheck()` reject → toast/inline 错误,按钮恢复可点。

## 测试策略

- **后端纯函数单测**:`rollupClusterStatus`(表驱动:全 ok→green;含 warn/unknown→yellow;含 down→red;空→green)。判级映射(信号→集群状态)抽纯函数测。采集 I/O 与并发靠 `go build` + 手测(本机 Go 1.25 可构建/跑测)。
- **前端**:`npm run typecheck` 改动文件不新增错误;手测按钮 → 并发探测 → 徽章/汇总/展开原因;无权限时按钮禁用。

## 范围外 (YAGNI)

- 不持久化健康历史、不做定时自动探活。
- 不含卷分布/容量压力/EC 等"深度体检"信号。
- 不改告警/调度/Guard。
- 不做单集群"重新检查"按钮(本次只批量;后续需要再加)。

## 受影响文件清单

新建 2(+本 spec):`internal/api/cluster_health_check.go`、`internal/api/cluster_health_check_test.go`。
修改 4:`internal/api/server.go`(路由)、`web/lib/api.ts`(类型 + 方法)、`web/app/clusters/page.tsx`(按钮 + 徽章 + 汇总)、`web/lib/i18n.ts`(zh keys)。
