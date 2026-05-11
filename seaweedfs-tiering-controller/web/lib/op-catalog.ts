// Op catalog — human-readable purpose + real command for every Skill step op.
// Lives on the frontend so we can render rich explanations next to each step
// without round-tripping the backend. When a new op is wired in the engine,
// add an entry here so the UI doesn't render "unknown op".
//
// `command` is a small template — substituteCommand() fills in volume_id,
// collection, master from the task context.

export interface OpExplanation {
  /** Short title shown next to the step in the waterfall (zh). */
  title: string;
  /** 1–2 sentence purpose (zh) shown in the expanded detail. */
  description: string;
  /** Real command/effect template. Use {volume_id}, {collection}, {master}. */
  command: string;
  /** Whether this op talks to SeaweedFS (true) or is internal (false). */
  external: boolean;
}

export const OP_CATALOG: Record<string, OpExplanation> = {
  // --- Locks & precondition ops -------------------------------------------
  acquire_volume_lock: {
    title: "获取卷级互斥锁",
    description:
      "在 PostgreSQL 上对 (volume_id, action) 申请 advisory lock,确保同一卷不会被两条任务同时操作。",
    command: "pg_try_advisory_lock(hash(volume_id={volume_id}, action))",
    external: false,
  },
  acquire_cluster_balance_lock: {
    title: "获取集群再平衡锁",
    description:
      "防止 balance / move 类任务在同一集群上并发执行,避免互相打架。",
    command: "pg_try_advisory_lock(hash('cluster:balance'))",
    external: false,
  },
  acquire_cluster_repair_lock: {
    title: "获取集群修复锁",
    description: "确保副本修复 / 删除 / EC 重建任务在集群粒度串行。",
    command: "pg_try_advisory_lock(hash('cluster:repair'))",
    external: false,
  },

  // --- Tiering (real impl) ------------------------------------------------
  tier_move_dat_to_remote: {
    title: "上传 .dat 到远端冷存",
    description:
      "通过 volume server gRPC 调用 VolumeTierMoveDatToRemote,把热卷 .dat 文件流式上传到 S3/OSS 等后端。",
    command:
      "grpc volume.{src_server} VolumeTierMoveDatToRemote(volume={volume_id}, collection={collection}, dest=<backend>)",
    external: true,
  },
  tier_move_dat_from_remote: {
    title: "从远端拉回 .dat",
    description: "回温:从远端 backend 把 .dat 重新拉回本地 volume server。",
    command:
      "grpc volume.{src_server} VolumeTierMoveDatFromRemote(volume={volume_id}, collection={collection})",
    external: true,
  },
  verify_remote_tier: {
    title: "校验远端分层",
    description:
      "查询 master,确认该卷的 RemoteStorageName/Key 已写入,意味着上传成功。",
    command: "grpc master VolumeList → check volume[{volume_id}].remote_storage_name != ''",
    external: true,
  },
  verify_local_dat: {
    title: "校验本地 .dat",
    description:
      "确认 .dat 真的回到了本地 disk,size 与 master 报告一致,防止半成功。",
    command: "grpc volume.{src_server} 检查 volume {volume_id} disk type & size",
    external: true,
  },
  volume_shrink_preallocated: {
    title: "回收预分配空间",
    description:
      "调用 volume server 的 VolumeShrinkPreallocated,把已删除文件腾出的空洞还给文件系统。",
    command: "grpc volume.{src_server} VolumeShrinkPreallocated(volume={volume_id})",
    external: true,
  },

  // --- Shell-driven ops (subprocess `weed shell`) -------------------------
  shell_volume_fix_replication: {
    title: "修复欠副本",
    description:
      "扫描 master 拓扑,对副本数低于 ReplicaPlacement 的卷自动复制一份到合适节点。",
    command:
      'weed shell -master={master} : "volume.fix.replication -apply -doDelete=false [-collectionPattern={collection}]"',
    external: true,
  },
  shell_volume_balance: {
    title: "卷再平衡",
    description: "把卷在 racks/data centers 之间挪动,平衡每个节点的容量与读写压力。",
    command: 'weed shell -master={master} : "volume.balance -force"',
    external: true,
  },
  shell_volume_vacuum: {
    title: "回收已删除空间",
    description: "对软删除文件做 compaction,把 .dat 中的墓碑数据真正清掉。",
    command: 'weed shell -master={master} : "volume.vacuum"',
    external: true,
  },
  shell_volume_fsck: {
    title: "数据完整性检查",
    description: "扫描所有卷的 needle,核对 index 与实际数据,报告损坏 chunk。",
    command: 'weed shell -master={master} : "volume.fsck"',
    external: true,
  },

  // --- Stub ops (Sprint 5+ 接真实现) --------------------------------------
  find_under_replicated: {
    title: "扫描欠副本卷",
    description: "遍历 master 拓扑找出 replica 数 < 期望值的卷,产出待修复清单。",
    command: "grpc master VolumeList → 过滤 |replicas| < expected",
    external: true,
  },
  ec_generate_shards: {
    title: "生成 EC 分片",
    description: "对一个 .dat 计算 10+4 Reed-Solomon 分片,提升存储效率。",
    command: "grpc volume EcGenerateShards(volume={volume_id})",
    external: true,
  },
  ec_distribute_shards: {
    title: "分散 EC 分片",
    description: "把 14 个分片分散到不同 rack 的 volume server,保证容灾。",
    command: "grpc EcShardCopy 跨节点复制 14 个 shard",
    external: true,
  },
  ec_remove_dat: {
    title: "移除原始副本",
    description: "EC 编码完成且校验通过后,删除原始 .dat 多副本以释放空间。",
    command: "grpc volume DeleteCollection / VolumeDelete(volume={volume_id})",
    external: true,
  },
  ec_remove_shards: {
    title: "移除 EC 分片",
    description: "回滚:把已生成的 14 个 shard 删除。",
    command: "grpc volume EcShardDelete(volume={volume_id})",
    external: true,
  },
  ec_rebuild_dat: {
    title: "从分片重建 .dat",
    description: "EC 解码:用幸存的 shard 重新拼出原始 .dat。",
    command: "grpc volume EcDecodeShards(volume={volume_id})",
    external: true,
  },
  volume_replicate: {
    title: "按策略复制卷",
    description: "根据 ReplicaPlacement(如 010 = 1+1+1)把卷复制到正确数量的节点。",
    command: "grpc volume.{src_server} VolumeCopy → 多节点",
    external: true,
  },
  volume_delete: {
    title: "删除多余副本",
    description: "对超副本卷选一个最不重要的实例下线。",
    command: "grpc volume VolumeDelete(volume={volume_id}, location=<chosen>)",
    external: true,
  },
  collection_plan_moves: {
    title: "规划集合迁移清单",
    description: "对一个 collection 的所有卷,产出按依赖顺序排好的迁移列表。",
    command: "internal: 拓扑 + 容量 + 业务标签算 plan",
    external: false,
  },
  collection_execute_moves: {
    title: "执行集合迁移",
    description: "按计划逐卷调用 VolumeMove,带速率限制和健康闸门。",
    command: "for v in plan: grpc VolumeMove(volume=v, dst=<chosen>)",
    external: true,
  },
  collection_revert_partial_moves: {
    title: "回滚部分迁移",
    description: "失败时把已经迁走的卷再迁回原节点,保证集合可用。",
    command: "for v in moved: grpc VolumeMove(volume=v, dst=<original>)",
    external: true,
  },
  compute_failover_matrix: {
    title: "计算容灾矩阵",
    description: "枚举每台节点宕机的最坏情况,统计可能丢失的卷/容量。",
    command: "internal: 拓扑模拟 + 副本去重",
    external: false,
  },

  // --- Preconditions (also surface in plan preview) -----------------------
  cluster_healthy: {
    title: "集群健康检查",
    description: "调 master VolumeList,确保所有 master/volume server 在线且 quorum 正常。",
    command: "grpc master VolumeList → 验证 topology",
    external: true,
  },
  candidate_nodes_exist: {
    title: "确认候选节点充足",
    description: "至少有一台健康节点有空闲容量,否则修复无目的地。",
    command: "internal: filter topology by free_space > volume_size",
    external: false,
  },
  cluster_admin_lock_acquirable: {
    title: "探测集群管理锁",
    description:
      "用 15s 短超时跑 `weed shell` 抢一次 master admin lock,失败立刻报错而不是让长任务卡住几小时。",
    command: 'weed shell -master={master} : "lock; unlock"  (15s 探测)',
    external: true,
  },
  in_change_window_or_emergency: {
    title: "检查变更窗口",
    description: "确认当前不在节假日 freeze 内,或任务带 emergency 标志强制放行。",
    command: "internal: check holidays + emergency flag",
    external: false,
  },
  not_in_blocklist: {
    title: "黑名单检查",
    description: "卷不在手动 block 列表上(已升级安全闸门触发的过期防护)。",
    command: "internal: SELECT FROM safety_blocklist",
    external: false,
  },

  // --- Side effects -------------------------------------------------------
  audit_log: {
    title: "写审计日志",
    description: "把本次操作的 who/what/when/result 落到 audit_log 表,合规可追溯。",
    command: "INSERT INTO audit_log (...) VALUES (...)",
    external: false,
  },
  emit_dry_run_report: {
    title: "产出 Dry-run 报告",
    description: "把仅模拟的执行计划写到 reports 表,供 NOC 人工复审。",
    command: "INSERT INTO dry_run_reports (...)",
    external: false,
  },
  emit_failover_report: {
    title: "产出容灾报告",
    description: "保存 failover matrix 结果,UI 风险大屏读取。",
    command: "INSERT INTO failover_reports (...)",
    external: false,
  },
  alert_if_at_risk: {
    title: "高危告警",
    description: "若失败矩阵或 fsck 报告达到阈值,按 alert_rules 路由到 Slack/PagerDuty。",
    command: "fan-out 到匹配的 alert_channels",
    external: false,
  },
};

export function explainOp(op: string): OpExplanation {
  return (
    OP_CATALOG[op] || {
      title: op,
      description: "(尚未在 op 字典登记;查看后端 internal/executor/skill_engine.go)",
      command: "(unknown)",
      external: false,
    }
  );
}

/** Substitutes {volume_id}, {collection}, {master} placeholders. */
export function substituteCommand(
  template: string,
  ctx: { volume_id?: number | string; collection?: string; master?: string; src_server?: string },
): string {
  return template
    .replace(/\{volume_id\}/g, String(ctx.volume_id ?? "?"))
    .replace(/\{collection\}/g, ctx.collection || "<all>")
    .replace(/\{master\}/g, ctx.master || "<master>")
    .replace(/\{src_server\}/g, ctx.src_server || "<volume-server>");
}
