# `cluster.raft.transferLeader` 平台接入 — 设计 (Spec)

**日期:** 2026-05-29
**状态:** 已批准设计,待写实现计划
**来源:** weed 能力差距审计 (P2 项) — `docs/audit/2026-05-29-weed-capability-gap-audit.md`

## 目标 (Goal)

把 SeaweedFS 的 `cluster.raft.transferLeader` shell 命令接入运维平台:提供一个专属 API 端点和 masters 页面上的操作按钮,让运维可以在对当前 master leader 做维护之前,主动、优雅地把 raft 领导权转移到另一台 master。

## 背景与命令契约

`cluster.raft.transferLeader` 的行为(取自 `weed/shell/command_cluster_raft_leader_transfer.go`):

- 参数:`-id <server_id>` 和 `-address <grpc_addr>`,二者**必须成对出现**;两者都不给则**自动选择**一个 eligible follower。
- 命令自身会先 `RaftListClusterServers` 定位当前 leader,再向 leader 发起 `RaftLeadershipTransfer` gRPC 调用。
- 前置条件:需要 hashicorp raft(master 启动带 `-raftHashicorp=true`);单 master 模式会返回错误 "leadership transfer not available in single master mode";目标必须是 voting member。
- 输出为人类可读文本:列出集群成员、`Transferring leadership from X to Y...`,随后是成功(Previous/New leader)、"same leader re-elected",或失败 + 自带 troubleshooting 提示。

设计用途:**维护前的准备动作**,把领导权从将要维护的节点挪走,减少 filer 等组件的报错。

## 设计决策

1. **暴露方式:专属端点 + masters 页按钮。** 不加入 shell catalog(allowlist)。理由:catalog 命令会经由通用 shell 控制台执行,而通用 shell 已套用 H1 的完整 `guardAllow`(紧急停止/变更窗口/维护/冻结)。本命令要求"仅紧急停止拦截",与完整 guard 冲突,因此必须走专属端点单一入口,避免语义分裂。
2. **安全 Guard:仅受紧急停止拦截。** 变更窗口、维护窗口、节假日冻结期间**放行** —— 因为转移领导权恰恰是这些时段做维护时需要的准备动作。仅当 `safety.emergency_stop` 开启时拒绝。
3. **目标选择:自动 + 可选指定(完整)。** 由于指定目标需要 raft server `Id`,而当前 `MasterRaftServer` 结构丢弃了 gRPC 响应里的 `Id`,需扩展捕获。前端下拉提供"自动"+ 非-leader voter 列表。

## 架构与组件

### 后端

**B1. `internal/seaweed/client.go` — 捕获 raft server Id**
- `MasterRaftServer` 结构新增字段 `Id string`(现有字段:`Address`、`Suffrage`、`IsLeader`)。
- `FetchMasterRaftServers` 在构造每个 `MasterRaftServer` 时填入 gRPC 响应的 `server.Id`(目前未捕获)。
- 不改变现有调用者行为(只是多一个字段)。

**B2. `internal/safety/guard.go` — 仅紧急停止判定**
- 抽出私有 helper:
  ```go
  func (g *Guard) emergencyStopped() bool {
      return g.snapshot != nil && g.snapshot.Bool("safety.emergency_stop", false)
  }
  ```
- 新增导出方法:
  ```go
  // AllowEmergencyOnly 只评估紧急停止门,跳过变更窗口/维护/冻结。
  // 用于"维护准备"类操作(如 raft 领导权转移),这些操作恰恰要在
  // 维护窗口内可用,但仍须服从全局紧急停止。
  func (g *Guard) AllowEmergencyOnly() Verdict {
      if g.emergencyStopped() {
          return Verdict{Allowed: false, Code: "emergency_stop",
              Reason: "Emergency stop is engaged. Disable it in Settings → safety.emergency_stop."}
      }
      return Verdict{Allowed: true}
  }
  ```
- `Allow` 的第 1 步改为复用 `g.emergencyStopped()`(DRY),保持 Verdict 文案不变。

**B3. `internal/api/guard_gate.go` — 紧急停止门控 helper**
- 新增 `guardEmergencyAllow(d Deps, c *gin.Context) bool`,镜像现有 `guardAllow`:`d.Guard == nil` 时放行;否则调 `d.Guard.AllowEmergencyOnly()`,被拦时写 `http.StatusLocked` (423) `{error, code, blocked_by:"safety_guard"}` 并返回 false。

**B4. `internal/api/cluster_masters.go` — 暴露 raft 成员列表给前端**
- 新增类型:
  ```go
  type raftServerInfo struct {
      ID       string `json:"id"`
      Address  string `json:"address"`
      Suffrage string `json:"suffrage"`
      IsLeader bool   `json:"is_leader"`
  }
  ```
- `clusterMastersResponse` 新增字段 `RaftServers []raftServerInfo `json:"raft_servers"``。
- 填充:用现在带 `Id` 的 raftPeers 观测构造(取任一可达 master 报告的 raft 成员集即可;若都不可达则为空数组,前端回退到"仅自动")。空时序列化为 `[]` 而非 `null`。

**B5. `internal/api/cluster_raft_transfer.go`(新文件) — 处理器**
```go
func clusterRaftTransferLeader(d Deps) gin.HandlerFunc {
    return func(c *gin.Context) {
        id, err := uuid.Parse(c.Param("id"))   // 400 if bad
        if !guardEmergencyAllow(d, c) { return } // 423 if emergency stop
        var body struct {
            TargetID      string `json:"target_id,omitempty"`
            TargetAddress string `json:"target_address,omitempty"`
        }
        _ = c.ShouldBindJSON(&body)
        // 成对校验
        if (body.TargetID == "") != (body.TargetAddress == "") {
            c.JSON(400, gin.H{"error": "target_id and target_address must be provided together"}); return
        }
        cl, err := d.PG.GetCluster(...)        // 404 if missing
        args := []string{}
        if body.TargetID != "" {
            args = append(args, "-id="+body.TargetID, "-address="+body.TargetAddress)
        }
        ctx, cancel := context.WithTimeout(c.Request.Context(), 60*time.Second)
        defer cancel()
        out, runErr := d.Sw.RunShellCommandAtWithBin(ctx, cl.MasterAddr, cl.WeedBinPath,
            "cluster.raft.transferLeader", args, nil)
        p, _ := auth.Of(c)
        _ = d.PG.Audit(ctx, p.Email, "cluster.raft.transfer-leader", "cluster", id.String(), map[string]any{
            "target_id": body.TargetID, "target_address": body.TargetAddress,
            "ok": runErr == nil,
        })
        if runErr != nil { c.JSON(502, gin.H{"error": runErr.Error(), "output": out}); return }
        c.JSON(200, gin.H{"output": out, "args": strings.Join(args, " ")})
    }
}
```
- 60s 超时:命令内部 list(10s)+ transfer(30s)有界,留余量。

**B6. `internal/api/server.go` — 路由**
- 在 master/raft 诊断区块加:
  ```go
  v1.POST("/clusters/:id/masters/transfer-leader",
      auth.RequireCap(d.Caps, "cluster.raft.transfer"), clusterRaftTransferLeader(d))
  ```

**B7. `migrations/pg/051_cluster_raft_transfer_cap.sql` — 能力种子**
- 仿 `026_cluster_lock_probe_cap.sql`:
  - `INSERT INTO capabilities` `cluster.raft.transfer`(category `cluster`,label "Transfer raft leadership",描述说明这是 mutating 的维护准备动作)`ON CONFLICT DO UPDATE`。
  - `INSERT INTO role_capabilities` 仅授 `admin`、`operator`(**不给** viewer/auditor —— 这是 mutating 操作)`ON CONFLICT DO NOTHING`。

### 前端

**F1. `web/lib/api.ts`**
- 新增类型:
  ```ts
  export interface RaftServerInfo {
    id: string;
    address: string;
    suffrage: "leader" | "voter" | "nonvoter" | "unknown";
    is_leader: boolean;
  }
  ```
- `ClusterMastersResponse`(或对应接口)新增 `raft_servers: RaftServerInfo[]`。
- `api` 对象新增:
  ```ts
  transferLeader: (clusterID: string, body?: { target_id: string; target_address: string }) =>
    jpost(`${BASE}/clusters/${clusterID}/masters/transfer-leader`, body ?? {}) as
      Promise<{ output: string; args: string }>,
  ```

**F2. `web/app/clusters/[id]/masters/page.tsx`**
- 在「Lock probe」卡片旁/下新增「Raft 领导权」卡片:
  - 目标 `<select>`:第一项"自动(任一 eligible follower)";其余为 `data.raft_servers` 里 `!is_leader && suffrage === "voter"` 的成员,显示 `id — address`,value 编码 `id` 与 `address`。
  - 「转移 leader」按钮:`disabled={!has("cluster.raft.transfer") || running}`;无 cap 时 title 提示 `Requires cluster.raft.transfer capability`。
  - 点击先弹**确认对话框**(原生 `confirm` 或现有弹窗组件):提示会触发一次短暂重选举。
  - 调 `api.transferLeader`;成功/失败都把 `output`(及 error)以等宽文本展示;成功后 `mutate()` 刷新 masters 表。
  - 状态用本地 `useState`(running、result),与现有 `runProbe` 同构。

**F3. `web/lib/i18n.ts`**
- 新增 zh keys:`"Raft leadership"`→"Raft 领导权"、`"Transfer leader"`→"转移 leader"、`"Auto (any eligible follower)"`→"自动(任一可用 follower)"、`"Transfer raft leadership to another master? This triggers a brief re-election."`→"将 raft 领导权转移到另一台 master?这会触发一次短暂的重新选举。"、`"Requires cluster.raft.transfer capability"`→"需要 cluster.raft.transfer 权限"、`"Target master"`→"目标 master" 等。

## 数据流

1. masters 页加载 → `GET /clusters/:id/masters` 现在带 `raft_servers`。
2. 运维选目标(或自动)→ 确认 → `POST /clusters/:id/masters/transfer-leader {target_id?, target_address?}`。
3. 后端 `guardEmergencyAllow` → 跑 shell → audit → 返回 output。
4. 前端展示 output;刷新 masters 表看新 leader。

## 错误处理

| 情况 | 响应 |
|------|------|
| cluster id 非法 | 400 |
| target_id / target_address 未成对 | 400 `target_id and target_address must be provided together` |
| 紧急停止开启 | 423 `{code:"emergency_stop", blocked_by:"safety_guard"}` |
| cluster 不存在 | 404 |
| 非 leader / 单 master / 目标不可达 / 命令失败 | 502 `{error, output}` —— output 含命令自带 troubleshooting 文案,前端原样展示 |

变更窗口/维护/冻结期间**不拦截**(本特性的核心决策)。

## 测试策略

- **后端:** 本地 Go 1.17 无法构建 1.25 代码 → 仅 gofmt + 静态符号一致性校验(`guardEmergencyAllow`/`AllowEmergencyOnly`/`clusterRaftTransferLeader` 定义与调用配对、路由注册、import 完整)。**用户负责实际 `go build ./...` 验证。** weed 命令本身已有单测 `command_cluster_raft_leader_transfer_test.go`。
- **前端:** `npm run typecheck 2>&1 | grep` 仅校验改动文件不引入**新**错误(仓库 tsc 既有 RED 基线);人工验证目标下拉、确认弹窗、无 cap 时按钮禁用、output 展示。

## 范围外 (YAGNI)

- 不在 `/raft` 全局页放入口(masters 页足够;后续需要再说)。
- 不做 SSE 流式(命令 30s 内返回,blocking 即可)。
- 不做转移后自动轮询验证新 leader(刷新 masters 表即可由运维肉眼确认)。
- 不加入 shell catalog(见决策 1)。

## 受影响文件清单

新建 2(+本 spec):`internal/api/cluster_raft_transfer.go`、`migrations/pg/051_cluster_raft_transfer_cap.sql`。
修改 8:`internal/seaweed/client.go`、`internal/safety/guard.go`、`internal/api/guard_gate.go`、`internal/api/cluster_masters.go`、`internal/api/server.go`、`web/lib/api.ts`、`web/app/clusters/[id]/masters/page.tsx`、`web/lib/i18n.ts`。
