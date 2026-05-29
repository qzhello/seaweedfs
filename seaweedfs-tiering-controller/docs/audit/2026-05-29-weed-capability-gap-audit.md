# weed 能力盘点 × 平台缺口/运维契合度审计

**日期:** 2026-05-29
**方法:** 6 个并行子 agent,逐域对照 upstream `weed` 命令面(CLI ~50 + shell 125)与控制器实现(`internal/api`、`internal/seaweed`、`internal/scorer/scheduler/executor`、`web/app`)。所有结论带 file:line 证据(见各域小节)。

> 总体结论:平台对 **volume / EC / cluster / collection / s3 / fs** 的覆盖**相当广**(读 + 写 + 部分自动化都有)。主要问题不是"没做",而是三类:
> **(A) 几处自动化执行器是 stub,任务静默失败(真 bug);(B) 安全护栏(变更窗口/紧急停止/能力校验)只在自动调度路径生效,直连 API/通用 shell 绕过;(C) 分层闭环与 DR 半截。**

---

## 一、必须先修的 Bug(低成本、影响真实功能)

| # | 问题 | 证据 | 影响 |
|---|------|------|------|
| B1 | **`ec_encode` 执行器是 stub**:`return fmt.Errorf("ec_encode not yet implemented")` | `internal/executor/executor.go:426-430` | scorer 自动产生的 EC 编码任务**全部立即失败**,冷卷自动 EC 永不发生,失败任务堆积 + 误报警 |
| B2 | **`tier_move` 执行器是 stub**:`return fmt.Errorf("tier_move not yet implemented")` | `internal/executor/executor.go:432-434` | 磁盘间(SSD↔HDD)迁移任务永远无法完成 |
| B3 | **`mq.topic.describe` 命名错误**(upstream 是 `mq.topic.desc`) | `shell_catalog.go:427` vs `weed/shell/command_mq_topic_desc.go` | ops 控制台执行该命令必报 unknown command,MQ 自省不可用 |
| B4 | **`cluster.raft.add` 表单缺 `-id`** 必填项(upstream 需 `-id <name> -address <addr>`) | `shell_catalog.go:417-419` | 引导式加节点必失败,只能 raw-args 兜底 |

---

## 二、跨域高危运维契合度问题(HIGH)

### H1 安全护栏只在自动调度生效,直连路径全绕过
`safety.Guard.Allow`(紧急停止 / 变更窗口 / 维护窗口 / 节假日冻结)只被 autonomy scheduler 调用(`scheduler.go:521-536`)。**直连 API handler 与通用 shell 全不检查**:
- `volume_ops.go`(balance/grow apply)、`cluster_ops.go`(configure.replication)、`volume_fix_replication.go`、`ec_ops.go`(encode/decode)、`clusters.go:clusterShellExec`、`drains.go` 均无 `d.Guard.Allow` 调用。
- 后果:运维(或 UI)可在冻结窗口/紧急停止期间直接发起 balance/EC/删除等重操作,安全系统沦为"建议"而非"强制"。
- **建议:** 在所有 mutating handler 入口加统一 guard 检查(返回 423 + 原因),一处中间件即可消除整类事故。

### H2 通用 shell 端点绕过能力系统 + 泄露明文密钥
`admin.POST /clusters/:id/shell`(`server.go:522`)仅 `RequireRole(admin)`,**不做 per-command cap 校验**(`clusters.go`)。任何 admin 可经此跑 `s3.iam.import`(覆盖全部凭据)、`s3.user.delete`、`s3.accesskey.*` 等,绕过 dedicated 端点的 cap 守卫。
- **明文密钥泄露(HIGH/安全):** `s3.accesskey.create/rotate`、`s3.iam.export` 把 `Secret Key: <sk>` / 全量凭据打到 stdout,`clusterShellExec` 原样回传到 HTTP body 并把 `args` 原样写审计日志(`clusters.go:184-199`)。会进代理日志/浏览器历史/审计库。dedicated 的 `s3UpsertIdentity` 已正确脱敏,通用路径没有。
- **建议:** (a) 通用 shell 响应/审计做密钥 scrub;(b) 给 catalog 项加 `RequiredCap` 并在 `clusterShellExec` 内强制;(c) 单独做 `GET /s3/iam/export`(脱敏 + 专属审计)。

### H3 分层闭环半截(平台核心使命)
- **无冷→热自动召回:** scorer 只产 `tier_upload`/`ec_encode`,从不产 `tier_download`(`scorer.go:124-135`)。热度回升的已分层卷不会自动拉回,只能手动/作为回滚逆操作。半个温度环是自动的,另一半不是。
- **`filer.remote.sync` / `filer.remote.gateway` 守护进程完全无管理:** 云端写回的关键长驻进程,平台无启动/重启/健康检查/滞后告警,单点失败静默。
- **建议:** scorer 增加 `score < recall_threshold` → 产 `tier_download`(skill JSON 已存在 `02_volume_tier_download.json`);为 remote-sync 守护进程加状态/滞后探测 + 告警。

### H4 删除/不可逆操作缺前置校验与二次确认
- `volume.delete` 单行操作不查是否最后一个副本(`volume-actions.tsx:87-89`、`volume_ops.go:521-568`)→ 可删掉唯一副本丢数据。
- 单桶删除走 `ShellActionDialog` 只有危险横幅,无 type-to-confirm(批量删除才有)。
- `s3.bucket.lock`(对象锁不可逆)仅一行横幅。
- `fs.meta.load`(覆盖全量 filer 元数据)无 dry-run / type-to-confirm / 专属审计。
- `cluster.raft.remove` 无 quorum 前置检查(已有 `/clusters/:id/masters` 一致性数据未接入)→ 在已退化的 quorum 上移除投票者会让集群下线。
- **建议:** 危险项统一加 type-to-confirm + 前置校验(最后副本检查、quorum 多数检查、删除前展示卷数/字节)。

### H5 DR 能力缺失
- 无 `fs.meta.save` 定时备份 + 平台侧留存/RPO 告警(快照只落在 weed-shell 主机本地,平台无记录)。
- `filer.sync`/`filer.backup`/`filer.meta.backup`(跨集群 DR 原语)完全无覆盖、无可观测。
- **建议:** 新增"元数据定时快照→对象存储→DB 记录→超 RPO 告警"skill;把 filer.sync 滞后纳入集群健康面。

### H6 raft 控制面运维缺口
- `cluster.raft.transferLeader` **完全不可达**(不在 catalog)→ master 计划性维护(重启/升级)只能 SSH 手动,风险高。
- **建议:** 加入 catalog + Masters 页非 leader 行旁的"转移领导权"按钮。

---

## 三、缺失功能清单(按运维价值)

**分层/远程(核心):** 冷→热自动召回(H3)、`volume.tier.compact` 不自动调度(云端垃圾累积)、`remote.*` 全生命周期仅通用 shell(无专属 API/UI/向导)、Backend 模型缺 `StorageClass`(用不上 DEEP_ARCHIVE/GLACIER 降本)、tier 步骤未透传 `-ioBytePerSecond` 限速。

**完整性/EC:** `ec.scrub`/`volume.scrub` 无专属端点/调度/结构化解析/告警(EC 静默损坏无人察觉)、`volume.check.disk` 仅只读(无 `-apply` 修复路径)、`volume.fsck` 无定时。

**卷:** `volume.deleteEmpty` 原生批量(`-quietFor` 安全网)未用、`volumeServer.evacuate`(先迁移再下线)未接入 drain(现用 `leave`,风险更高)、`volume.mount/unmount` 无 UI(崩溃恢复路径)、`volume.server.state`(维护模式位)未暴露。

**Filer:** `fs.merge.volumes`、`fs.distribute.chunks`、`fs.meta.change.volume.id` 不在 catalog;`fs.configure` 无引导表单/无 diff 预览;接入网关(webdav/sftp/nfs/mount)生命周期不可见。

**S3/IAM:** 新版 gRPC IAM(`s3.user.* / s3.group.* / s3.policy.* / s3.serviceaccount.* / s3.accesskey.*`)无结构化 API/UI(多租户管理全靠 CLI);`s3.iam.export/import` 无备份/恢复工作流;`s3.bucket.access` / `s3.anonymous.*` 仅通用 shell。

**集群/MQ:** `cluster.raft.transferLeader` 缺(H6);MQ 域整体仅 catalog 直通、无 UI(若 MQ 非平台目标可接受,但需明确)。

**已正确判定为 out-of-scope:** 守护进程启动类 CLI(`master/server/volume/s3/filer/mq.broker/...`)、`benchmark/scaffold/update/version`、离线工具 `compact/fix`、`sleep`。

---

## 四、运维契合度评分(各域)

| 域 | 覆盖广度 | 运维护栏成熟度 | 关键短板 |
|----|---------|--------------|---------|
| 卷生命周期/均衡 | 高 | 中 | 直连 API 绕过 guard;最后副本无校验;drain 用 leave 非 evacuate |
| EC/完整性 | 中高 | 中低 | ec_encode stub(bug);scrub 无端点/调度/告警;check.disk 无修复 |
| 分层/远程(核心) | 中 | 中低 | 无冷→热召回;tier_move stub;remote.* 仅 shell;无 StorageClass |
| Filer/fs/数据 | 中 | 低 | DR 缺位(meta 备份/filer.sync);meta.load 无确认 |
| S3/IAM/多租户 | 中高(老模型) | 低(安全) | 明文密钥泄露;通用 shell 绕过 cap;新 IAM 无 UI |
| 集群/master/raft/MQ | 中 | 中 | transferLeader 缺;raft.remove 无 quorum 前置;命名 bug |

---

## 五、建议的优先级路线

1. **P0(本周,低成本高收益):** 修 4 个 bug(B1–B4);通用 shell 密钥脱敏(H2a)。
2. **P1(护栏强制):** 全 mutating handler 接入 `Guard.Allow`(H1);通用 shell 加 per-command cap(H2b);危险操作 type-to-confirm + 前置校验(H4)。
3. **P2(核心闭环):** 冷→热召回 + 实现 tier_move(H3、B2);ec.scrub 端点+调度+告警;check.disk 修复路径。
4. **P3(DR & 控制面):** 元数据定时备份 + filer.sync 可观测(H5);raft.transferLeader + quorum 前置(H6、H4)。
5. **P4(能力补全):** 新版 S3 IAM 结构化 UI;remote.* 向导 + StorageClass;volume.deleteEmpty 批量/evacuate-first drain。

> 各域完整覆盖表、逐命令证据与 Top5 建议见审计原始输出(本文件为综合版)。
