"use client";

// Volume Balance — visual planner.
//
// Flow: operator picks (optional) collection/DC/rack scope → "Compute
// plan" hits POST /clusters/:id/volume/balance/plan which runs
// `volume.balance` WITHOUT -force. The dry-run output is parsed into a
// list of moves; we visualise them as a Sankey (source node → target
// node, edge weight = move count) and a before/after node-volume bar
// chart that projects the plan onto the current distribution. The
// operator can then click Apply which streams `volume.balance -force`
// via the existing /clusters/:id/shell/stream endpoint.

import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { Scale, Play, Loader2, AlertTriangle, RefreshCw } from "lucide-react";
import { api, useVolumes, type Volume, getToken } from "@/lib/api";
import { useCluster } from "@/lib/cluster-context";
import { useT } from "@/lib/i18n";
import { Can } from "@/components/can";
import { chartColors as C } from "@/lib/chart-theme";

const ReactECharts = dynamic(() => import("echarts-for-react"), { ssr: false });

type Move = { volume_id: number; from: string; to: string; collection?: string; size_mb?: number };

export default function BalancePage() {
  const { t } = useT();
  return (
    <Can
      cap="volume.balance"
      fallback={<div className="card p-6 text-sm text-muted">{t("You don't have permission to view this page.")}</div>}
    >
      <BalanceInner/>
    </Can>
  );
}

function BalanceInner() {
  const { t } = useT();
  const { clusterID } = useCluster();
  const { data: vd } = useVolumes(clusterID);

  const [scope, setScope] = useState({ collection: "", data_center: "", rack: "" });
  const [planning, setPlanning] = useState(false);
  const [moves, setMoves] = useState<Move[] | null>(null);
  const [rawOutput, setRawOutput] = useState<string>("");
  const [applyOut, setApplyOut] = useState<string>("");
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState("");

  if (!clusterID) {
    return <div className="card p-6 text-sm text-muted">{t("Pick a cluster in the top-right to start.")}</div>;
  }

  const items = vd?.items || [];
  // Group volumes by server to compute current distribution. Mirrors
  // the logic in /volumes/page.tsx (buildDist) but kept local to keep
  // this page self-contained.
  const beforeByNode = useMemo(() => {
    const m = new Map<string, number>();
    for (const v of items) m.set(v.Server, (m.get(v.Server) || 0) + 1);
    return m;
  }, [items]);

  // Project the plan: subtract one from `from`, add one to `to` per move.
  const afterByNode = useMemo(() => {
    const m = new Map(beforeByNode);
    for (const mv of moves || []) {
      m.set(mv.from, (m.get(mv.from) || 0) - 1);
      m.set(mv.to,   (m.get(mv.to)   || 0) + 1);
    }
    return m;
  }, [beforeByNode, moves]);

  const plan = async () => {
    setPlanning(true); setError(""); setMoves(null); setRawOutput("");
    try {
      const r = await api.balancePlan(clusterID, scope);
      setMoves(r.moves);
      setRawOutput(r.output);
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setPlanning(false);
    }
  };

  const apply = async () => {
    if (!moves || moves.length === 0) return;
    if (!confirm(t("Apply the balance plan? This moves data across nodes."))) return;
    setApplying(true); setApplyOut("");
    try {
      const qs = new URLSearchParams({ command: "volume.balance", args: buildArgs(scope, true), reason: "balance from /volumes/balance" });
      const token = getToken();
      if (token) qs.set("token", token);
      const url = `${process.env.NEXT_PUBLIC_API_BASE || "http://127.0.0.1:8080"}/api/v1/clusters/${clusterID}/shell/stream?${qs}`;
      const es = new EventSource(url, { withCredentials: true });
      es.addEventListener("line", (ev: MessageEvent) => setApplyOut(s => s + ev.data + "\n"));
      es.addEventListener("done", () => { es.close(); setApplying(false); });
      es.onerror = () => { es.close(); setApplying(false); };
    } catch (e: unknown) {
      setApplying(false);
      setError((e as Error).message);
    }
  };

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-base font-semibold tracking-tight inline-flex items-center gap-2">
          <Scale size={16}/> {t("Volume Balance")}
        </h1>
        <p className="text-xs text-muted mt-1">
          {t("Compute a dry-run plan, inspect the migrations, then apply with one click.")}
        </p>
      </header>

      {/* Scope + actions */}
      <section className="card p-4 flex flex-wrap items-end gap-3">
        <Field label={t("Collection")} value={scope.collection} onChange={v => setScope(s => ({ ...s, collection: v }))} placeholder="(all)"/>
        <Field label={t("Data center")} value={scope.data_center} onChange={v => setScope(s => ({ ...s, data_center: v }))} placeholder="(any)"/>
        <Field label={t("Rack")} value={scope.rack} onChange={v => setScope(s => ({ ...s, rack: v }))} placeholder="(any)"/>
        <div className="flex-1"/>
        <button className="btn inline-flex items-center gap-1.5" onClick={plan} disabled={planning}>
          {planning ? <Loader2 size={14} className="animate-spin"/> : <RefreshCw size={14}/>}
          {t("Compute plan")}
        </button>
        <button
          className="btn inline-flex items-center gap-1.5 bg-accent/15 text-accent border-accent/40"
          onClick={apply}
          disabled={applying || !moves || moves.length === 0}
        >
          {applying ? <Loader2 size={14} className="animate-spin"/> : <Play size={14}/>}
          {t("Apply plan")}{moves ? ` (${moves.length})` : ""}
        </button>
      </section>

      {error && (
        <div className="card p-3 text-xs text-rose-300 border-rose-400/30 bg-rose-400/10 inline-flex items-center gap-2">
          <AlertTriangle size={14}/> {error}
        </div>
      )}

      {moves !== null && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Sankey: from → to flow */}
          <section className="card flex flex-col">
            <header className="px-4 py-2 border-b border-border/60 text-xs font-medium uppercase tracking-wider text-muted">
              {t("Migration flow")}
            </header>
            {moves.length === 0 ? (
              <div className="p-8 text-center text-sm text-muted">{t("Nothing to balance.")}</div>
            ) : (
              <ReactECharts style={{ height: 360 }} option={sankeyOption(moves)}/>
            )}
          </section>

          {/* Before/After distribution */}
          <section className="card flex flex-col">
            <header className="px-4 py-2 border-b border-border/60 text-xs font-medium uppercase tracking-wider text-muted">
              {t("Per-node volume count (before vs after)")}
            </header>
            <ReactECharts style={{ height: 360 }} option={beforeAfterOption(beforeByNode, afterByNode)}/>
          </section>

          {/* Move list */}
          <section className="card lg:col-span-2 overflow-hidden">
            <header className="px-4 py-2 border-b border-border/60 text-xs font-medium uppercase tracking-wider text-muted flex items-center justify-between">
              <span>{t("Moves")} · {moves.length}</span>
              <span className="font-normal normal-case text-[11px] text-muted">{t("Click a row to highlight in the flow chart.")}</span>
            </header>
            <div className="max-h-64 overflow-auto">
              <table className="grid w-full text-xs">
                <thead>
                  <tr>
                    <th className="text-left">{t("Volume")}</th>
                    <th className="text-left">{t("Collection")}</th>
                    <th className="text-left">{t("From")}</th>
                    <th className="text-left">{t("To")}</th>
                    <th className="text-right">{t("Size (MB)")}</th>
                  </tr>
                </thead>
                <tbody>
                  {moves.map((m, i) => (
                    <tr key={`${m.volume_id}-${i}`}>
                      <td className="font-mono">#{m.volume_id}</td>
                      <td>{m.collection || "—"}</td>
                      <td className="font-mono text-muted">{m.from}</td>
                      <td className="font-mono">{m.to}</td>
                      <td className="text-right tabular-nums">{m.size_mb || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {rawOutput && (
            <details className="card p-3 lg:col-span-2 text-xs">
              <summary className="cursor-pointer text-muted">{t("Raw shell output")}</summary>
              <pre className="mt-2 whitespace-pre-wrap break-all font-mono text-[11px] text-muted max-h-40 overflow-auto">{rawOutput}</pre>
            </details>
          )}
        </div>
      )}

      {applyOut && (
        <section className="card p-3">
          <div className="text-xs uppercase tracking-wider text-muted mb-1">{t("Apply output")}</div>
          <pre className="text-[11px] font-mono whitespace-pre-wrap break-all max-h-72 overflow-auto">{applyOut}</pre>
        </section>
      )}
    </div>
  );
}

function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div className="space-y-1 min-w-[160px]">
      <label className="text-[11px] text-muted">{label}</label>
      <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} className="input w-full"/>
    </div>
  );
}

function buildArgs(s: { collection: string; data_center: string; rack: string }, force: boolean) {
  const parts: string[] = [];
  if (s.collection) parts.push(`-collection=${s.collection}`);
  if (s.data_center) parts.push(`-dataCenter=${s.data_center}`);
  if (s.rack) parts.push(`-rack=${s.rack}`);
  if (force) parts.push("-force");
  return parts.join(" ");
}

function sankeyOption(moves: Move[]) {
  // Build src→dst edge weights. Nodes are server addresses, drawn at
  // two columns: sources on the left, targets on the right. Same node
  // can appear on both sides (a "transit" node) — ECharts handles that.
  const edges = new Map<string, number>();
  const nodes = new Set<string>();
  for (const m of moves) {
    const key = `${m.from}>>${m.to}`;
    edges.set(key, (edges.get(key) || 0) + 1);
    nodes.add(m.from); nodes.add(m.to);
  }
  const links = [...edges.entries()].map(([k, v]) => {
    const [from, to] = k.split(">>");
    return { source: from, target: to, value: v };
  });
  return {
    backgroundColor: "transparent",
    tooltip: { trigger: "item", backgroundColor: C.tooltipBg, borderColor: C.tooltipBorder, textStyle: { color: C.text } },
    series: [{
      type: "sankey",
      emphasis: { focus: "adjacency" },
      data: [...nodes].map(n => ({ name: n })),
      links,
      lineStyle: { color: "gradient", curveness: 0.5, opacity: 0.5 },
      itemStyle: { borderColor: C.axisLine, color: C.accent },
      label: { color: C.textMuted, fontSize: 11 },
    }],
  };
}

function beforeAfterOption(before: Map<string, number>, after: Map<string, number>) {
  const nodes = [...new Set([...before.keys(), ...after.keys()])].sort((a, b) => (after.get(b) || 0) - (after.get(a) || 0));
  return {
    backgroundColor: "transparent",
    grid: { left: 110, right: 12, top: 22, bottom: 8 },
    legend: { data: ["Before", "After"], top: 0, right: 24, textStyle: { color: C.textMuted, fontSize: 11 } },
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, backgroundColor: C.tooltipBg, borderColor: C.tooltipBorder, textStyle: { color: C.text } },
    xAxis: { type: "value", axisLabel: { color: C.textMuted, fontSize: 11 }, splitLine: { lineStyle: { color: C.grid } } },
    yAxis: { type: "category", data: nodes, inverse: true, axisLabel: { color: C.textMuted, fontSize: 11, formatter: (v: string) => v.length > 22 ? "…" + v.slice(-21) : v } },
    series: [
      { name: "Before", type: "bar", data: nodes.map(n => before.get(n) || 0), itemStyle: { color: C.textMuted }, barMaxWidth: 12 },
      { name: "After",  type: "bar", data: nodes.map(n => after.get(n)  || 0), itemStyle: { color: C.accent },    barMaxWidth: 12 },
    ],
  };
}
