# 导航即时渲染 UI、数据渐进填充 — 设计 (Spec)

**日期:** 2026-05-29
**状态:** 已批准设计,待写实现计划
**类型:** 前端 UX 改造(无后端改动)

## 目标 (Goal)

点击导航时,页面 UI 骨架(面包屑、tab 栏、页头、卡片轮廓)立即出现,数据到达后渐进填充对应区域 —— 取代当前"整页等数据加载完才显示"的体验。

## 背景与根因

当前点击 cluster 详情下的某个 tab,用户经历多层串行阻塞:

1. **布局层阻塞** —— `app/clusters/[id]/layout.tsx` 中 `if (!data && !error) return <CardSkeleton/>`,在 `useClusterTopology` 返回前,**连 tab 栏和面包屑都不渲染**,整个详情区域是一块骨架。
2. **页面层阻塞** —— 约 19 个子页各自有 `if (isLoading || !data) return <整页 spinner/>`,页面自身结构(页头、卡片轮廓)在该页数据到达前完全不显示。

净效果:click → 路由 loading → 布局等 topology → 页面等自身数据 → 才出内容。多段全区块阻塞,被感知为"卡顿、点了没反应"。

现有可复用原语(`components/table-skeleton.tsx`):`TableSkeleton({rows, cols, headers})`、`CardSkeleton({lines, title})`、`SkeletonBar({w, h})`。SWR 已配置导航间保留旧数据(二次访问已访问过的页几乎瞬时);本次改造针对**首次访问无缓存**时的体验。

## 设计决策

1. **范围:布局层 + cluster 详情高流量子树**(7 个子页)。admin 面板、s3 资源详情、costs/activity fleet、temperature 等低流量页留作后续。
2. **模式:骨架优先**(而非"页头 + 数据区 spinner",也不用 React Suspense 重构)。数据区渲染与真实结构同形的骨架,最贴合"UI 先出、数据慢慢渲染",且复用现成原语、无新依赖、低风险。

## 核心技术(贯穿所有改动)

把**持久化骨架**移出 loading gate:页头(标题/描述/Refresh 按钮)、卡片外壳等只依赖 `id`/caps、不依赖远程数据的部分**始终渲染**;只有**数据区**在加载中显示骨架占位。

判据用 `isLoading && !data`(有旧数据就直接渲染旧数据,不闪骨架)。

终态分支保持整块返回,不套骨架:
- 权限拒绝(`!has(...)`)→ 现有的"无权限"卡片。
- `error` → 现有的错误卡片。

## 架构与组件

### 改动 1:`app/clusters/[id]/layout.tsx` —— 让 chrome 立即渲染

当前结构(简化):
```tsx
const { data, error } = useClusterTopology(shouldFetchTopology ? id : undefined);
if (!data && !error) {
  if (capsLoading) return null;
  if (isReadSurface && !canReadCluster) return <无权限卡片/>;
  if (isShellRoute && !canUseShell) return <无权限卡片/>;
  return <CardSkeleton lines={3} title={false}/>;   // ← 这里吞掉了 tab + 面包屑
}
const cluster = data?.cluster || null;
const topology = data?.topology || null;
const visibleTabs = TABS.filter(...);
return (<Context.Provider><div>面包屑 + 子头部 + tab 栏 + {children}</div></Context.Provider>);
```

改为:**保留权限拒绝的早返回**,但**删除 `return <CardSkeleton/>` 这条整块骨架早返回**,让函数始终走到底部的 JSX 渲染。把 chrome 永远渲染,只对依赖 topology 的部分做条件骨架:

- `capsLoading` 时仍 `return null`(caps 是渲染 tab 可见性的前置,且很快)。
- 权限拒绝分支保留(终态)。
- 删除 `if (!data && !error) { ... return <CardSkeleton/> }` 这层 —— 后续 JSX 用 `data?.cluster`(已是可空)兜底。
- `cluster`/`topology` 经 context 传下去,仍可为 null;消费方已用 `cluster?.x` 兜底。
- 子头部那行 `master_addr` + badges:topology 未到(`!data && !error`)时渲染一个 `SkeletonBar`(窄条)占位,到达后显示真实值。
- tab 栏:不变(其可见性只依赖 `capsLoading`/caps,与 topology 无关),始终渲染。
- `{children}`:始终渲染(子页自己负责其数据区骨架)。

注意:`ClusterDetailContext.Provider` 现在在 `data` 未到时也会渲染,`topology` 为 null。确认所有消费 `useClusterDetail()` 的子页对 `cluster === null` / `topology === null` 有兜底(多数已用可选链;实现时逐一核查改动范围内的 7 个子页)。

### 改动 2–8:7 个 cluster 详情子页 —— 骨架优先

对每个页面采用同一模式:把页头与卡片外壳移出 loading gate,数据区按结构选骨架。

通用变换:
```tsx
// 之前
if (isLoading || !data) return <整页 spinner/>;
return (<div><Header/><DataSections data={data}/></div>);

// 之后
return (
  <div>
    <Header/>                                     {/* 始终渲染:标题/描述/Refresh */}
    {isLoading && !data
      ? <骨架(TableSkeleton 或 CardSkeleton)/>     {/* 数据区占位 */}
      : <DataSections data={data}/>}
  </div>
);
```

保留 `!has(...)` 与 `error` 的整块早返回。

各页数据区骨架类型:

| 文件 | 数据区骨架 |
|------|-----------|
| `clusters/[id]/masters/page.tsx` | 一致性面板 → `CardSkeleton`;masters 表 → `TableSkeleton rows={4} headers={[Address, Health, Role, Reported leader, ...]}`。Lock probe / Raft leadership 卡片本就不依赖列表数据(只读 `data.raft_servers`,用 `?? []` 兜底),始终渲染。 |
| `clusters/[id]/filers/page.tsx` | filer 表 → `TableSkeleton`(表头沿用页面现有列) |
| `clusters/[id]/ec-shards/page.tsx` | shard 表/网格 → `TableSkeleton` 或 `CardSkeleton` 视现有结构 |
| `clusters/[id]/volumes/[vid]/page.tsx` | 详情卡片 → `CardSkeleton`(若有副本表则加 `TableSkeleton`) |
| `clusters/[id]/ec-volumes/[vid]/page.tsx` | 详情卡片 + 14 分片表 → `CardSkeleton` + `TableSkeleton` |
| `clusters/[id]/volume-servers/[addr]/page.tsx` | 节点详情卡片 → `CardSkeleton` |
| `clusters/[id]/collections/[name]/page.tsx` | collection 详情 + 卷表 → `CardSkeleton` + `TableSkeleton` |

实现时**先读各页现有结构**,确定页头/卡片外壳的真实边界与列名,再套用变换 —— 不臆造结构。

## 数据流

无后端/数据流变更。SWR hooks 不变;改的只是组件在 `isLoading`/`!data` 时渲染什么。`keepPreviousData` 行为不变(二次访问仍渲染旧数据)。

## 错误处理

- 权限拒绝、远程 `error`:保持现有整块返回(终态,不套骨架)。
- 判据统一为 `isLoading && !data`,确保有旧数据时不闪骨架。
- 布局层:topology `error` 时,chrome 仍渲染,子头部显示 `master unavailable`(沿用现状),`{children}` 照常(子页各自处理其数据 error)。

## 测试策略

无后端改动。

- **类型检查:** `npm run typecheck 2>&1 | grep "<file>"` 对每个改动文件,确保不新增错误(仓库 tsc 既有 RED 基线,只看改动文件)。
- **人工验证(首次无缓存):** 硬刷新后进入布局 + 7 个子页,确认:面包屑/tab 栏/页头/卡片外壳**立即**出现;数据区先骨架后填充;二次切换(有缓存)仍瞬时、不闪骨架;无权限/错误时显示对应终态卡片而非骨架。
- 断点检查 320/768/1024/1440 无溢出(骨架沿用现有卡片/表格容器,风险低)。

## 范围外 (YAGNI)

- admin 面板(ai-usage/permissions/users)、s3 资源详情、costs/activity fleet、temperature 等低流量页 —— 后续单独处理。
- 不引入 React Suspense / 路由级 streaming 重构。
- 不新增骨架原语(复用 `table-skeleton.tsx` 现有三个)。
- 不改 SWR 配置 / 数据获取逻辑。

## 受影响文件清单

修改 8:`app/clusters/[id]/layout.tsx`、`app/clusters/[id]/masters/page.tsx`、`app/clusters/[id]/filers/page.tsx`、`app/clusters/[id]/ec-shards/page.tsx`、`app/clusters/[id]/volumes/[vid]/page.tsx`、`app/clusters/[id]/ec-volumes/[vid]/page.tsx`、`app/clusters/[id]/volume-servers/[addr]/page.tsx`、`app/clusters/[id]/collections/[name]/page.tsx`。
新建 0(复用现有骨架原语;本 spec 文档除外)。
