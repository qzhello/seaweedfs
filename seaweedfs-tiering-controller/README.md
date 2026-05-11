# SeaweedFS Tiering Controller

外挂式数据智能分层控制平面。**不修改 SeaweedFS 源码**,通过 gRPC + access log 采集,
驱动 `volume.tier.move` / `ec.encode` / `volume.tier.upload` 等已有命令完成
热 → 温 → 冷 → 归档 的分层迁移。

## 架构

```
┌──────────────────────────────────────────────────────────────┐
│  Web UI (Next.js + shadcn + ECharts)                         │
│  Dashboard | Heatmap | Policies | Tasks | AI Config | Audit  │
└────────────────────────┬─────────────────────────────────────┘
                         │ REST/JSON
┌────────────────────────▼─────────────────────────────────────┐
│  Controller (Go + Gin)                                       │
│  ┌──────────┐ ┌─────────┐ ┌──────────┐ ┌──────────────────┐  │
│  │ API      │ │ Scorer  │ │ Executor │ │ AI Provider      │  │
│  │          │ │ rule+AI │ │ +Rollback│ │ openai/anthropic │  │
│  └──────────┘ └─────────┘ └────┬─────┘ └──────────────────┘  │
└────────┬────────────────────────┼────────────────────────────┘
         │                        │ gRPC
   ┌─────▼─────┐ ┌────────────┐  ┌▼─────────────┐
   │ PostgreSQL│ │ ClickHouse │  │  SeaweedFS   │
   │ policy/   │ │ access_log │  │  master +    │
   │ task/exec │ │ profile    │  │  volumes     │
   └───────────┘ └────────────┘  └──────────────┘
            ▲
            │ fluentd / kafka
   ┌────────┴───────┐
   │ S3 Audit Log   │  (SeaweedFS 自带,设置 S3_AUDIT_LOG_CONFIG 即可)
   └────────────────┘
```

## 模块

| 模块 | 职责 |
|---|---|
| `cmd/controller` | API + 调度器主进程 |
| `cmd/collector` | 消费 fluentd/kafka 访问日志写入 ClickHouse |
| `internal/seaweed` | SeaweedFS master/volume gRPC 客户端封装 |
| `internal/scorer` | 特征聚合 + 打分(规则+AI) |
| `internal/executor` | 触发迁移命令 + 回滚 |
| `internal/ai` | 可插拔 AI Provider(OpenAI/Anthropic/Rule) |
| `internal/api` | REST handler |
| `web/` | Next.js 运维平台 |

## 快速启动

```bash
make dev          # 起 PG + CH + controller + web
make migrate      # 跑 SQL 迁移
make seed         # 灌入样例数据
```

UI: <http://localhost:3000>  ·  API: <http://localhost:8080>

## 配置

见 `config/config.example.yaml`。关键项:
- `seaweed.master`: master 地址
- `ai.provider`: openai / anthropic / rule
- `policies.cooldown`: 迁移冷却窗口(默认 14d)

## 设计原则

1. **零侵入**:只调 SeaweedFS 已有 gRPC,不打 patch
2. **可回滚**:每个 executions 记录反向操作,UI 一键回滚
3. **可解释**:打分调试器展示每个特征贡献
4. **可观测**:全链路 trace_id,executions 表即审计
5. **灰度**:策略支持 sample_rate / dry_run / 白名单
