# 总览(Overview)重构设计

**日期:** 2026-05-29
**分支:** dev-volume-shrink
**作者:** qzhello + Claude

---

## 1. 背景与目标

当前总览页(`web/app/page.tsx`)第一行是一张全宽的"集群耐久性"大图,占用空间过大;
其下方另有一排 KPI 卡片。整体信息密度不均、不够清晰。

目标是把总览改造成一个**运维一眼看清全局**的页面:

1. 第一行:左半边耐久性大图,右半边 6 个核心 KPI 紧凑卡片。
2. 新增一张**角色拓扑大图**(master / filer / volume + 调用关系连线),用**颜色深浅表示压力分**。
3. 压力分有一套可配置的计算逻辑(权重、指标),**点击拓扑图即可修改配置**。
4. 指标采集也在此配置:从 Prometheus 用 PromQL 拉取多个关键指标,**定期写入 ClickHouse 做时序聚合**。

---

## 2. 跨期决策:数据架构(ClickHouse 混合方案)

**决策:采集到 ClickHouse(混合读)。** 已与用户确认。

- **历史/聚合**:采集器定时(可配间隔)用 PromQL 从 Prometheus 批量拉取关键指标,
  写入 ClickHouse 时序表,供趋势、聚合、压力评分使用。
- **当前值**:拓扑图的"当前压力色"和 KPI 当前值读最近一条采样即可,不依赖 Prometheus 在线。
- **取舍**:展示数据存在"拉取间隔"级别延迟(如 30s),对运维总览完全够用。

**为何不直接读 Prometheus:** 用户明确要"很多关键指标可配置拉取 + 方便聚合查询 + 历史",
这是 ClickHouse 的主场;且仓库已有"采集器 → ClickHouse"成熟套路(`cmd/collector`、
`internal/collector/features.go`、ClickHouse 迁移)。直接读 Prometheus 会让面板与 Prom 在线状态
强耦合,且历史范围受 Prom 保留期限制。

### 已存在、可复用的后端能力(探索代码确认)

- **PromQL 抓取**:`internal/health/scraper.go` 已支持 `kind=prometheus_query` 的 `monitor_targets`,
  打 Prometheus `/api/v1/query` 取值。但当前只把"最新值"写进 PG 的 `health_state.last_value`,
  **没有写时序到 ClickHouse**。
- **压力评分**:`internal/pressure/pressure.go` 已计算每集群 0..1 压力分,
  **权重已可配**(runtime 配置 `pressure.weights`,默认 `cpu_p95/disk_util_p95/io_wait`),
  阈值 `pressure.threshold`,快照入 PG `cluster_pressure_signals`。
- **ClickHouse**:`store.NewCH` 已接入,采集器已向 `tiering.access_log`、features 快照写入。
- **前端图表**:已用 `echarts-for-react`(`ReactECharts`),其 `graph` series 可画力导向节点图(拓扑)。

---

## 3. 分期路线图(每期独立交付、独立验收)

| 期 | 内容 | 性质 | 依赖 |
|----|------|------|------|
| **第1期** | 总览第一行布局重排 | 纯前端 | 无 |
| **第2期** | 指标采集管道:可配置多 PromQL → 定时拉取 → ClickHouse 时序 + 聚合查询接口 | 后端为主 + 配置 UI | 无(复用现有 PromQL/CH) |
| **第3期** | 压力评分扩展(更多指标:磁盘总量/卷数/剩余空间…)+ 按角色算分 + 配置接口 | 后端 + 配置 | 第2期(指标数据) |
| **第4期** | 角色拓扑大图(master/filer/volume + 连线 + 压力色)+ 点击节点弹配置面板 | 前端 + 拓扑接口 | 第3期(每角色压力分) |

> 本设计文档**详细规格仅覆盖第1期**。第2~4期为高层草图,各自在实现前再走一次
> brainstorm → spec → plan 细化(每期一个独立 spec)。

### 约束(重要)

本机 Go 版本为 1.17,控制器需要 Go 1.25,因此**后端代码只能修改 + gofmt 格式化,无法本地编译/跑测试**
(见记忆 [[go-toolchain-gap]])。第2~4期的后端改动需要用户那边构建验证;第1期是纯前端,可本地验证。

---

## 4. 第1期详细设计:总览第一行布局重排

### 4.1 目标布局(已迭代:右半改为 Bento 富视觉)

> **迭代记录:** 初版右半用 6 个纯数字紧凑卡,用户评价"很丑、信息太少",改为**富视觉 Bento**:
> 容量合并成进度条、卷与只读各做成环形(展示当前/最大、只读/总的比例)。

```
┌──────────────────────────────┬──────────────────────────────┐
│ 耐久性总览卡片(左半,lg 50%)  │ Bento(右半)                   │
│ [状态药丸行: ✓全部正常 ⚡压力] │ ┌──────────────────────────┐  │
│ ◯60  集群耐久性 / 存在风险      │ │ 容量 ▓▓▓▓▓░░ 进度条        │  │ ← 总容量+可用合并
│ /100 由 raft 仲裁与复制风险汇总 │ └──────────────────────────┘  │
│ (含 EnterButton → /raft)      │ ┌────────────┬─────────────┐  │
│                               │ │ ◔卷         │ ◐只读       │  │ ← 环形:当前/最大、只读/总
│                               │ ├────────────┼─────────────┤  │
│                               │ │ 待处理(数字) │ 月度节省(数字)│  │
│                               │ └────────────┴─────────────┘  │
└──────────────────────────────┴──────────────────────────────┘
```

- 用户已选定 **Bento(方案 A)**。
- 耐久性卡片内容不变(状态药丸已移入卡片顶部),仅宽度收到一半。

### 4.2 改动文件

只改前端,主要是 `web/app/page.tsx`,可能新增一个小组件 + 少量 i18n。

**第一行结构(替换现有两块):**
- 移除现有"独立全宽耐久性 hero 行"(`<div className="relative">…HealthOverview…EnterButton…</div>`)
  与其下方"KPI `<SortableRow rowKey="kpis">`"两块,合并为**一行两列**:

```tsx
<div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
  {/* 左:耐久性 hero(原内容,带 statusSlot 与 EnterButton) */}
  <div className="relative">
    <HealthOverview masters={durMasters} repl={durRepl} statusSlot={hasStatus ? statusPills : undefined}/>
    <EnterButton href={`/raft${scopeCluster ? `?cluster=${scopeCluster}` : ""}`} label={t("Cluster durability")}/>
  </div>
  {/* 右:6 个 KPI,3 列 × 2 行 */}
  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 content-start">
    {/* 6 个 KpiTile,固定顺序 */}
  </div>
</div>
```

### 4.3 Bento 的 5 张卡 + 数据来源(全部复用现有数据,零新增后端)

| 卡 | 视觉 | 数据 | 跳转 |
|----|------|------|------|
| 容量 Capacity(整行) | 水平进度条 已用/总 | `diskUsage.{used,total,free}_bytes`;无 disk 数据时回退 `nodeStats.usedSlots/maxSlots` + `bytes(total)` 标题 | /volumes |
| 卷 Volumes(环) | 环形 当前/最大槽位 | center=`s?.volumes_total ?? nodes.totalVolumes`;arc=`nodeStats.usedSlots / nodeStats.maxSlots` | /volumes |
| 只读 Read-only(环) | 环形 只读/总卷(warning 色) | `nodes.readOnly / nodes.totalVolumes` | /volumes?readonly=1 |
| 待处理 Pending(数字) | 复用 `Stat` | `pending?.items?.length` + hot recs sub | /activity?tab=tasks |
| 月度节省 Monthly savings(数字) | 复用 `Stat` | `costsNow.monthly_saving`(无则字节估算回退) | /costs |

### 4.4 KPI 卡片组件

- **容量**:新增局部组件 `BarStat`(label + 标题数值 + 水平进度条 + 左右两端说明),格式化与 `t()`
  在 Dashboard 内算好后以已翻译字符串传入。
- **卷 / 只读**:新增局部组件 `RingStat`(SVG 环 + 中心数字 + 右侧 value/max + sub),`tone` 区分
  accent(卷)/ warning(只读)。环用 `stroke-dasharray` 实现,复用 `HealthOverview` 里 `ScoreRing`
  的画法,主题友好。
- **待处理 / 月度节省**:复用现有 `Stat`。
- 全部**固定顺序、不可拖拽**;与左侧耐久性卡视觉语言一致(`card` 底色/边框/角落 `EnterButton`)。
- 新增 i18n 键:`"Capacity": "容量"`;其余 `used / slots / free / of fleet` 已存在,复用。

### 4.5 移除项

- 移除下方整排 KPI `<SortableRow rowKey="kpis">`(9 卡)。
- 被移除的条件告警卡(`运行中 running`、`24h 失败 failed_24h`、`集群数 clusters`)
  **不再以 KPI 卡形式出现**:运行/失败信息已由「今日关注 TodaysAttention」面板与状态药丸覆盖;
  集群数一键点进 /clusters。
- 不可拖拽 → 与上次已删除的"重置布局"按钮一致。

### 4.6 响应式

- 第一行:`lg` 及以上两列;`lg` 以下堆叠(耐久性整宽在上,KPI 在下)。
- KPI 网格:`grid-cols-2`(小屏)→ `sm:grid-cols-3`。
- 验证断点无溢出:375 / 768 / 1024 / 1440。

### 4.7 清理与注意

- `nodes` / `nodeStats` 在下方分布图仍使用 → 保留。
- 移除 kpis 行后,检查是否有**仅该行使用**的 import / 变量变为未使用(如某些图标、`SortableItem` 仅在该处),
  按需清理。`SortableRow` 仍被监控图表/列表行使用 → 保留。
- i18n:标签键多数已存在(`Volumes`、`Total Size`、`Free headroom`、`Read-only`、`Pending`、
  `Monthly savings`);实现时确认缺失键并补充中文。

### 4.8 测试(第1期,前端)

- `tsc --noEmit` 对改动文件零新增错误。
- 视觉回归:1440 / 1024 / 768 / 375 四个断点截图;明/暗两主题;确认无溢出、对齐正常。
- 功能:6 个 KPI 数值与跳转链接正确;空数据(无 diskUsage / 无 costs)时回退展示合理。

---

## 5. 第2~4期高层草图(后续各自细化)

### 第2期:指标采集管道(PromQL → ClickHouse)
- 新增可配置"指标采集项"概念:`name + promql + prometheus_url + 间隔 + 标签维度`。
  可复用/扩展 `monitor_targets`,或新建 `metric_collectors` 表(细化时决定)。
- 采集器定时批量拉取 → 写 ClickHouse 时序表(如 `tiering.metric_samples(ts, metric, cluster, role, instance, value)`)。
- 新增聚合查询接口(按时间窗/角色/集群聚合)。
- 配置 UI:增删改采集项;PromQL 校验;预览最近值。

### 第3期:压力评分扩展 + 按角色算分
- 扩展 `internal/pressure`:支持更多指标(磁盘总量、卷数、剩余空间、IO 等)与**按角色**(master/filer/volume)算分。
- 权重/阈值/指标集配置接口(在现有 `pressure.weights` runtime 配置基础上扩展)。
- 数据来源切换到第2期的 ClickHouse 时序聚合。

### 第4期:角色拓扑大图 + 点击配置
- 后端拓扑接口:返回 master/filer/volume 节点、调用关系边、每节点当前压力分。
- 前端用 ECharts `graph` series 画力导向拓扑,节点颜色深浅映射压力分。
- 点击节点/图 → 弹出第3期的压力配置面板 + 第2期的采集配置入口。

---

## 6. 开放问题(留待对应期细化)

- 第2期:复用 `monitor_targets` 还是新建 `metric_collectors`?ClickHouse 表结构与保留期?
- 第3期:按角色压力分的具体指标与归一化口径;master/filer/volume 各自权重是否独立?
- 第4期:拓扑的"调用关系"数据从何而来(SeaweedFS 拓扑 API / 配置 / 推断)?
