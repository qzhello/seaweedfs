# 总览第1期 · 第一行布局重排 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把总览第一行改成「左半边耐久性大图 + 右半边 6 个核心 KPI 紧凑卡」,并移除下方那排独立 KPI。

**Architecture:** 纯前端改动,只动 `web/app/page.tsx`。新 KPI 复用现有 `Stat` 组件与现有数据表达式(零新增 hook/后端)。把原"全宽耐久性 hero"与"KPI SortableRow"两块合并为一个两列网格行,然后删除仅服务于旧 KPI 行的死代码。

**Tech Stack:** Next.js (App Router) + React + TypeScript + Tailwind;图标 lucide-react;i18n `@/lib/i18n` 的 `t()`。

---

## 重要前置说明(给执行者)

1. **本机不能跑后端**,但本期是纯前端,可用 `npm run dev`(端口 3001)本地验证。所有命令在 `web/` 目录下执行。
2. **`tsc` 本来就报红**:仓库 `lib/i18n.ts` 等存在预存重复键/类型错误(约 34 个 `TS1117` 等),与本期无关。因此验证门槛是
   **"`app/page.tsx` 不出现新错误"**,而不是"全绿"。统一用过滤命令:
   ```bash
   npm run typecheck 2>&1 | grep -E "app/page\.tsx" ; echo "exit:$?"
   ```
   期望:**无输出**(grep 无匹配)。
3. 无前端测试框架(无 jest/vitest/playwright)。本期为纯视觉布局改动,按项目约定用
   **类型检查 + lint + dev 服务器人工视觉确认**,不新建测试框架(YAGNI)。
4. 编辑用字符串匹配(Edit 工具的 old_string/new_string),不要依赖绝对行号——行号会随编辑漂移。

---

## File Structure

| 文件 | 改动 | 职责 |
|------|------|------|
| `web/app/page.tsx` | 修改 | 总览页:重排第一行、删除旧 KPI 行、清理死代码 |

无新增文件。复用 `Stat`(同文件,约 578 行)。

---

## Task 1: 第一行改为「耐久性 + 6 KPI」两列网格,并删除旧 KPI 行

**Files:**
- Modify: `web/app/page.tsx`

- [ ] **Step 1: 用新两列行替换原全宽耐久性 hero 块**

把这段(原全宽 hero,含其上方注释):

```tsx
      {/* Hero — durability score, full width. Side-by-side with another
          card looked uneven (ring + deductions never matches a signal
          grid), so it gets its own row. The corner EnterButton routes
          to /raft for the full master / per-volume drill-down. */}
      <div className="relative">
        <HealthOverview masters={durMasters} repl={durRepl} statusSlot={hasStatus ? statusPills : undefined}/>
        <EnterButton
          href={`/raft${scopeCluster ? `?cluster=${scopeCluster}` : ""}`}
          label={t("Cluster durability")}
        />
      </div>
```

替换为(左半耐久性 + 右半 6 个 KPI,全部复用现有数据表达式与现有 i18n 键):

```tsx
      {/* First row — durability hero (left half) + 6 core KPIs (right
          half). The old full-width hero and the separate KPI row below
          were merged here so the operator sees vitals without scrolling.
          KPIs are a fixed, curated set: scale → capacity → space →
          read-only → backlog → savings. Compact Stat cards, no drag. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
        <div className="relative">
          <HealthOverview masters={durMasters} repl={durRepl} statusSlot={hasStatus ? statusPills : undefined}/>
          <EnterButton
            href={`/raft${scopeCluster ? `?cluster=${scopeCluster}` : ""}`}
            label={t("Cluster durability")}
          />
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 content-start">
          <Stat
            href="/volumes"
            icon={<Database size={18}/>}
            label={t("Volumes")}
            value={s?.volumes_total ?? nodes.totalVolumes}
          />
          <Stat
            href="/volumes"
            icon={<Activity size={18}/>}
            label={t("Total Size")}
            value={diskUsage && Number(diskUsage.total_bytes) > 0 ? bytes(Number(diskUsage.total_bytes)) : bytes(total)}
          />
          <Stat
            href="/clusters"
            icon={<HardDrive size={18}/>}
            label={t("Free headroom")}
            value={bytes(Number(diskUsage?.free_bytes) || 0)}
            sub={diskUsage && Number(diskUsage.total_bytes) > 0
              ? `${((Number(diskUsage.free_bytes ?? 0) / Math.max(1, Number(diskUsage.total_bytes ?? 1))) * 100).toFixed(1)}% ${t("free")}`
              : undefined}
          />
          <Stat
            href="/volumes?readonly=1"
            icon={<Lock size={18}/>}
            label={t("Read-only")}
            value={nodes.readOnly}
            sub={`${nodes.totalVolumes ? ((nodes.readOnly / nodes.totalVolumes) * 100).toFixed(1) : 0}% ${t("of fleet")}`}
          />
          <Stat
            href="/activity?tab=tasks"
            icon={<Flame size={18}/>}
            label={t("Pending")}
            value={pending?.items?.length ?? 0}
            sub={`${pending?.items?.filter((p:any)=>p.score>=0.75).length ?? 0} ${t("hot recs")}`}
          />
          {costsNow && costsNow.monthly_saving > 0 ? (
            <Stat
              href="/costs"
              icon={<DollarSign size={18}/>}
              label={t("Monthly savings")}
              value={`${costsNow.currency} ${costsNow.monthly_saving.toFixed(0)}`}
              sub={t("vs. all-hot baseline")}
            />
          ) : (
            <Stat
              href="/activity?tab=executions"
              icon={<Snowflake size={18}/>}
              label={t("Saving est.")}
              value={bytes(((s?.bytes_warm||0)+(s?.bytes_cold||0))*0.5)}
              sub={t("vs. 3-replica baseline")}
            />
          )}
        </div>
      </div>
```

> 说明:`TodaysAttention` 当前就在 hero 与旧 KPI 行之间,本步不动它——删掉旧 KPI 行后,它自然落在新第一行的下方,顺序变成 [第一行] → 今日关注 → 监控图表。

- [ ] **Step 2: 删除旧 KPI 行(SortableRow rowKey="kpis")整块**

删除从下面这段注释开始:

```tsx
      {/* KPI cards — each item carries a stable id so the operator's
          drag-and-drop order survives reloads. `visible` toggles a card
          off without touching the saved order, so the layout returns
          intact when the condition flips back. */}
      <SortableRow
        rowKey="kpis"
```

一直到它的闭合 `/>`(紧接着 `{/* Charts and lists are split ... */}` 注释之前):

```tsx
          ];
          return kpiItems;
        })()}
      />
```

整段(注释 + 整个 `<SortableRow rowKey="kpis" … />`)全部删除。删除后,`<TodaysAttention/>` 下一行应直接是
`{/* Charts and lists are split into two rows … */}` 注释。

- [ ] **Step 3: 类型检查无新增错误**

Run:
```bash
cd web && npm run typecheck 2>&1 | grep -E "app/page\.tsx"
```
Expected: **无输出**。(此时 `VolumesStat`/`StatGauge`/`Server` 等会变成"未使用",但 `tsc` 未开 `noUnusedLocals`,不会因此报错;真正的清理在 Task 2,由 lint 把关。)

- [ ] **Step 4: 启动 dev 服务器肉眼确认第一行**

Run:
```bash
cd web && npm run dev
```
打开 http://localhost:3001 ,确认:
- 第一行左半是耐久性大图(顶部状态药丸还在),右半是 6 个 KPI(3 列 × 2 行):卷 / 总容量 / 可用空间 / 只读 / 待处理 / 月度节省。
- 下方不再有重复的那排 KPI;再往下依次是「今日关注」「监控图表」。
- 数值与跳转(点右上角箭头)正确;无明显错位/溢出。
确认后 Ctrl+C 停掉 dev。

- [ ] **Step 5: 提交**

```bash
cd /Users/quzhihao/GolandProjects/seaweedfs_qzh/seaweedfs-tiering-controller
git add seaweedfs-tiering-controller/web/app/page.tsx
git commit -m "feat(overview): 第一行改为 耐久性(半宽) + 6 KPI(半宽),移除旧 KPI 行"
```

---

## Task 2: 清理仅服务旧 KPI 行的死代码

旧 KPI 行删除后,以下符号只被它使用,需移除以保持 lint 干净、无死代码。

**Files:**
- Modify: `web/app/page.tsx`

- [ ] **Step 1: 从 lucide-react import 移除 Server / Play / AlertOctagon**

把:
```tsx
import { Activity, Database, Flame, Snowflake, Zap, RefreshCw, ShieldAlert, ShieldCheck, Server, Lock, HardDrive, Play, AlertOctagon, ThermometerSnowflake, DollarSign, ArrowUpRight, ListChecks } from "lucide-react";
```
改为:
```tsx
import { Activity, Database, Flame, Snowflake, Zap, RefreshCw, ShieldAlert, ShieldCheck, Lock, HardDrive, ThermometerSnowflake, DollarSign, ArrowUpRight, ListChecks } from "lucide-react";
```
> 注:`page.tsx` 第 ~790 行的 `v.Server` 是对象属性访问,不是这个图标,不受影响。`Zap`(Top recommendations)、`ThermometerSnowflake`、`ListChecks` 仍在别处使用,保留。

- [ ] **Step 2: 移除只服务旧 KPI 的两个数据 hook(running / failedAll)与陈旧注释**

把:
```tsx
  const { data: pending } = useTasks("pending");
  // Operator pulse: running + failed task counts so the dashboard
  // doubles as an "is anything wrong right now?" view. SWR's
  // refreshInterval keeps these fresh without manual reload.
  const { data: running } = useTasks("running");
  const { data: failedAll } = useTasks("failed");
  const { data: clusters } = useClusters();
```
改为:
```tsx
  const { data: pending } = useTasks("pending");
  const { data: clusters } = useClusters();
```

- [ ] **Step 3: 移除 failedRecent useMemo**

删除这段(原 88–91 行附近):
```tsx
  // "Failed in the last 24h" — the global failed bucket can grow
  // without bound, but only the very recent failures need operator
  // attention. Older ones live in /tasks for forensic browsing.
  const failedRecent = useMemo(() => {
    const cutoff = Date.now() - 24 * 3600 * 1000;
    return (failedAll?.items ?? []).filter((t: any) => new Date(t.created_at).getTime() >= cutoff);
  }, [failedAll]);
```
> 上方注释文字可能与代码连写,删除时确保把整段 `const failedRecent = useMemo(...)` 连同其上的 3 行注释一起删掉。`useMemo` 仍被 `coldCollections`、`nodes`、`nodeStats` 使用,import 保留。

- [ ] **Step 4: 删除 StatGauge 组件(仅旧"总容量"卡使用)**

删除从注释 `// Stat card variant with a horizontal "fuel gauge" below the value.` 开头,到 `function StatGauge({ … }) { … }` 的闭合 `}` 为止的整段(当前约 616–674 行)。

- [ ] **Step 5: 删除 VolumesStat 与 LegendDot 组件(仅旧"卷"卡使用)**

删除从注释 `// VolumesStat — KPI card that pairs the headline volume count` 开头,到 `function VolumesStat({ … }) { … }` 闭合 `}` 为止的整段(当前约 676–746 行);并删除紧随其后、仅被 `VolumesStat` 使用的:
```tsx
function LegendDot({ color }: { color: string }) {
  return <span className="inline-block w-2.5 h-2.5 rounded-[3px] align-middle mr-1" style={{ background: color }}/>;
}
```
> `LegendDot` 仅在 `VolumesStat` 内部(原 738–740 行)使用;若其实现与上面略有出入,以文件实际为准,删整 `function LegendDot(...) { ... }`。

- [ ] **Step 6: 类型检查 + lint 确认干净**

Run:
```bash
cd web && npm run typecheck 2>&1 | grep -E "app/page\.tsx"; echo "tc-exit"
cd web && npm run lint 2>&1 | grep -E "app/page\.tsx|Error|warn" | head -30; echo "lint-done"
```
Expected:
- typecheck 过滤后**无 `app/page.tsx` 行**。
- lint 对 `app/page.tsx` **无 unused-vars / no-undef 报错**(若报某符号未使用,按提示删除该符号;若报某符号未定义,说明误删,补回)。

- [ ] **Step 7: 提交**

```bash
cd /Users/quzhihao/GolandProjects/seaweedfs_qzh/seaweedfs-tiering-controller
git add seaweedfs-tiering-controller/web/app/page.tsx
git commit -m "refactor(overview): 移除旧 KPI 行专用的死代码(StatGauge/VolumesStat/LegendDot 等)"
```

---

## Task 3: 跨断点 + 双主题视觉验收

**Files:** 无(仅验证;若发现问题回 Task 1 调整 className)

- [ ] **Step 1: 启动 dev 并逐断点检查**

```bash
cd web && npm run dev
```
在浏览器 http://localhost:3001 ,用开发者工具切换视口宽度,逐一确认无溢出/错位:
- **1440 / 1024**:第一行两列(左耐久性、右 3 列 KPI)。
- **768**:`lg` 以下两列塌为堆叠 —— 耐久性整宽在上,KPI 在下(此时 KPI 为 `sm:grid-cols-3`,3 列)。
- **375**:KPI 退为 `grid-cols-2`(2 列),数值不挤压、不溢出。

- [ ] **Step 2: 双主题确认**

用页面右上角主题切换,确认明/暗两套主题下卡片底色、边框、文字对比度都正常(KPI 卡复用 `Stat` 的 `card` 样式,应天然一致)。

- [ ] **Step 3:(可选)production build 冒烟**

```bash
cd web && npm run build 2>&1 | tail -20
```
> 若 build 因**预存**的 i18n/其它文件错误失败,确认报错文件**不是** `app/page.tsx` 即可(本期不负责修预存错误)。Ctrl+C 停 dev。

- [ ] **Step 4: 无需提交**(纯验证;如有 className 微调,并入 Task 1 的提交或单独 `style(overview): …` 提交)

---

## Task 4: 右半区改为 Bento 富视觉 KPI(迭代)

初版 6 个纯数字卡被评"很丑、信息太少"。改为 Bento:容量合并成进度条;卷、只读各做成环形(展示当前/最大、只读/总);待处理、月度节省保留数字。用户已选定此版式(方案 A)。

**Files:**
- Modify: `web/app/page.tsx`
- Modify: `web/lib/i18n.ts`(新增一个键)

- [ ] **Step 1: 新增 i18n 键 `Capacity`**

在 `web/lib/i18n.ts` 的 Dashboard 段(`"Check": "检查",` 附近)加一行:
```ts
  "Capacity":                 "容量",
```

- [ ] **Step 2: 新增 `BarStat` 与 `RingStat` 两个局部组件**

在 `web/app/page.tsx` 中 `function Stat(...) { ... }` 定义之后,紧接着加入这两个组件(`EnterButton`、`React` 类型均已在作用域):

```tsx
// Capacity-style KPI: headline value + horizontal progress bar + a
// left/right caption row. Used for the merged total+free capacity card.
// Text is pre-translated by the caller so this stays presentational.
function BarStat({
  icon, label, headline, headlineSub, pct, leftLabel, rightLabel, href,
}: {
  icon: React.ReactNode; label: string; headline: React.ReactNode; headlineSub?: string;
  pct: number; leftLabel: string; rightLabel: string; href?: string;
}) {
  const w = Math.min(100, Math.max(0, pct * 100));
  return (
    <div className="card p-4 relative">
      <div className="text-xs text-muted flex items-center gap-2 pr-6">{icon}{label}</div>
      <div className="text-2xl font-semibold mt-1">
        {headline}{headlineSub && <span className="text-xs text-muted font-normal"> {headlineSub}</span>}
      </div>
      <div className="mt-2 h-2.5 rounded-full bg-border overflow-hidden">
        <div className="h-full rounded-full bg-accent transition-[width] duration-700" style={{ width: `${w}%` }}/>
      </div>
      <div className="flex justify-between text-xs text-muted mt-1.5">
        <span>{leftLabel}</span><span>{rightLabel}</span>
      </div>
      {href && <EnterButton href={href} label={label}/>}
    </div>
  );
}

// Ring KPI: an SVG donut showing value/max, a headline number in the
// center, and value/max + sub beside it. Used for volumes (used vs max
// slots) and read-only (read-only vs total). tone picks the arc color.
function RingStat({
  icon, label, center, value, max, sub, tone = "accent", href,
}: {
  icon: React.ReactNode; label: string; center: React.ReactNode;
  value: number; max: number; sub: string; tone?: "accent" | "warning"; href?: string;
}) {
  const pct = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const r = 26, circ = 2 * Math.PI * r;
  const toneCls = tone === "warning" ? "text-warning" : "text-accent";
  return (
    <div className="card p-4 h-full flex flex-col min-h-[110px] relative">
      <div className="text-xs text-muted flex items-center gap-2 pr-6">{icon}{label}</div>
      <div className="flex items-center gap-3 mt-2">
        <div className="relative w-[58px] h-[58px] shrink-0">
          <svg viewBox="0 0 64 64" className="w-[58px] h-[58px] -rotate-90">
            <circle cx="32" cy="32" r={r} fill="none" strokeWidth="6" className="stroke-border"/>
            <circle cx="32" cy="32" r={r} fill="none" strokeWidth="6" strokeLinecap="round"
              stroke="currentColor"
              className={`${toneCls} transition-[stroke-dashoffset] duration-700`}
              strokeDasharray={circ} strokeDashoffset={circ * (1 - pct)}/>
          </svg>
          <div className="absolute inset-0 flex items-center justify-center text-base font-semibold tabular-nums">{center}</div>
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold tabular-nums">
            {value}{max > 0 && <span className="text-muted font-normal"> / {max}</span>}
          </div>
          <div className="text-xs text-muted mt-0.5">{sub}</div>
        </div>
      </div>
      {href && <EnterButton href={href} label={label}/>}
    </div>
  );
}
```

- [ ] **Step 3: 用 Bento 替换右半区的 6-Stat 网格**

把右半区这一整块(`<div className="grid grid-cols-2 sm:grid-cols-3 gap-3 content-start"> … </div>`,即 6 个 `<Stat>`):

```tsx
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 content-start">
          <Stat
            href="/volumes"
            icon={<Database size={18}/>}
            label={t("Volumes")}
            value={s?.volumes_total ?? nodes.totalVolumes}
          />
          <Stat
            href="/volumes"
            icon={<Activity size={18}/>}
            label={t("Total Size")}
            value={diskUsage && Number(diskUsage.total_bytes) > 0 ? bytes(Number(diskUsage.total_bytes)) : bytes(total)}
          />
          <Stat
            href="/clusters"
            icon={<HardDrive size={18}/>}
            label={t("Free headroom")}
            value={bytes(Number(diskUsage?.free_bytes) || 0)}
            sub={diskUsage && Number(diskUsage.total_bytes) > 0
              ? `${((Number(diskUsage.free_bytes ?? 0) / Math.max(1, Number(diskUsage.total_bytes ?? 1))) * 100).toFixed(1)}% ${t("free")}`
              : undefined}
          />
          <Stat
            href="/volumes?readonly=1"
            icon={<Lock size={18}/>}
            label={t("Read-only")}
            value={nodes.readOnly}
            sub={`${nodes.totalVolumes ? ((nodes.readOnly / nodes.totalVolumes) * 100).toFixed(1) : 0}% ${t("of fleet")}`}
          />
          <Stat
            href="/activity?tab=tasks"
            icon={<Flame size={18}/>}
            label={t("Pending")}
            value={pending?.items?.length ?? 0}
            sub={`${pending?.items?.filter((p:any)=>p.score>=0.75).length ?? 0} ${t("hot recs")}`}
          />
          {costsNow && costsNow.monthly_saving > 0 ? (
            <Stat
              href="/costs"
              icon={<DollarSign size={18}/>}
              label={t("Monthly savings")}
              value={`${costsNow.currency} ${costsNow.monthly_saving.toFixed(0)}`}
              sub={t("vs. all-hot baseline")}
            />
          ) : (
            <Stat
              href="/activity?tab=executions"
              icon={<Snowflake size={18}/>}
              label={t("Saving est.")}
              value={bytes(((s?.bytes_warm||0)+(s?.bytes_cold||0))*0.5)}
              sub={t("vs. 3-replica baseline")}
            />
          )}
        </div>
```

替换为 Bento(容量进度条整行 + 卷/只读环 + 待处理/月度节省):

```tsx
        <div className="flex flex-col gap-3">
          {/* Capacity — total + free merged into one progress bar. Uses
              real disk bytes when available, else slot-based fallback. */}
          {(() => {
            const hasDisk = !!(diskUsage && Number(diskUsage.total_bytes) > 0);
            const used = hasDisk ? (Number(diskUsage?.used_bytes) || 0) : nodeStats.usedSlots;
            const tot  = hasDisk ? (Number(diskUsage?.total_bytes) || 0) : nodeStats.maxSlots;
            const free = hasDisk ? (Number(diskUsage?.free_bytes) || 0) : Math.max(0, nodeStats.maxSlots - nodeStats.usedSlots);
            const pct  = tot > 0 ? used / tot : 0;
            return (
              <BarStat
                href="/volumes"
                icon={<Activity size={18}/>}
                label={t("Capacity")}
                headline={hasDisk ? bytes(used) : bytes(total)}
                headlineSub={t("used")}
                pct={pct}
                leftLabel={`${(pct * 100).toFixed(0)}% ${t("used")}`}
                rightLabel={hasDisk
                  ? `${bytes(free)} ${t("free")} · ${bytes(tot)}`
                  : `${free} ${t("free")} · ${tot} ${t("slots")}`}
              />
            );
          })()}

          {/* Volumes (used vs max slots) + Read-only (read-only vs total) */}
          <div className="grid grid-cols-2 gap-3">
            <RingStat
              href="/volumes"
              icon={<Database size={18}/>}
              label={t("Volumes")}
              center={s?.volumes_total ?? nodes.totalVolumes}
              value={nodeStats.usedSlots || nodes.totalVolumes}
              max={nodeStats.maxSlots}
              sub={nodeStats.maxSlots > 0
                ? `${((nodeStats.usedSlots / nodeStats.maxSlots) * 100).toFixed(0)}% · ${nodeStats.maxSlots} ${t("slots")}`
                : t("slots")}
            />
            <RingStat
              href="/volumes?readonly=1"
              icon={<Lock size={18}/>}
              label={t("Read-only")}
              tone="warning"
              center={nodes.readOnly}
              value={nodes.readOnly}
              max={nodes.totalVolumes}
              sub={`${nodes.totalVolumes ? ((nodes.readOnly / nodes.totalVolumes) * 100).toFixed(1) : 0}% ${t("of fleet")}`}
            />
          </div>

          {/* Pending / Monthly savings — plain number Stat cards */}
          <div className="grid grid-cols-2 gap-3">
            <Stat
              href="/activity?tab=tasks"
              icon={<Flame size={18}/>}
              label={t("Pending")}
              value={pending?.items?.length ?? 0}
              sub={`${pending?.items?.filter((p:any)=>p.score>=0.75).length ?? 0} ${t("hot recs")}`}
            />
            {costsNow && costsNow.monthly_saving > 0 ? (
              <Stat
                href="/costs"
                icon={<DollarSign size={18}/>}
                label={t("Monthly savings")}
                value={`${costsNow.currency} ${costsNow.monthly_saving.toFixed(0)}`}
                sub={t("vs. all-hot baseline")}
              />
            ) : (
              <Stat
                href="/activity?tab=executions"
                icon={<Snowflake size={18}/>}
                label={t("Saving est.")}
                value={bytes(((s?.bytes_warm||0)+(s?.bytes_cold||0))*0.5)}
                sub={t("vs. 3-replica baseline")}
              />
            )}
          </div>
        </div>
```

同时把上面那段注释里 “Compact Stat cards, no drag.” 一行改为反映 Bento(可选):`Bento: capacity bar + volume/read-only rings + number cards.`

- [ ] **Step 4: 类型检查无新增错误**
```bash
cd web && npm run typecheck 2>&1 | grep -E "app/page\.tsx|lib/i18n\.ts" | grep -v "TS1117"; echo "done"
```
期望:无 `app/page.tsx` 行(`lib/i18n.ts` 的 TS1117 重复键是预存,已用 `grep -v` 滤掉)。

- [ ] **Step 5: lint**
```bash
cd web && npm run lint 2>&1 | grep -iE "app/page\.tsx|error|warning" | head -30; echo "done"
```
期望:`app/page.tsx` 无 unused/undefined 报错。

- [ ] **Step 6: 提交**
```bash
cd /Users/quzhihao/GolandProjects/seaweedfs_qzh
git add seaweedfs-tiering-controller/web/app/page.tsx seaweedfs-tiering-controller/web/lib/i18n.ts
git commit -m "feat(overview): 右半区改为 Bento 富视觉(容量进度条 + 卷/只读环 + 数字卡)"
```

---

## Self-Review(已核对)

- **Spec 覆盖**:第1期规格 4.1–4.8 全部对应到任务 —— 布局(T1S1)、6 KPI 数据映射(T1S1)、复用 Stat(T1S1)、移除旧行(T1S2)、死代码清理(T2)、响应式(T1 className + T3)、测试/验收(T3)。i18n 键全为现有,无需新增(4.7 确认)。
- **占位符扫描**:无 TBD/TODO;每个改代码的步骤都给了完整 old/new 或明确的函数删除边界。
- **类型/命名一致**:沿用现有 `Stat` props(icon/label/value/sub/href)、现有数据变量(`s`/`diskUsage`/`nodes`/`pending`/`costsNow`/`total`/`bytes()`)与现有 i18n 键,均在文件中已定义。
- **验证门槛**:已针对"`tsc` 预存报红"改为 `app/page.tsx` 无新增错误的过滤判定。
