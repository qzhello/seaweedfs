"use client";

// volumeServer.leave — drain a volume server before maintenance.
//
// Single-page step flow:
//   1. Pick a node from a sortable / searchable list with live KPIs.
//   2. Review an impact preview — replica-safety check (does any volume
//      on this node lack a replica elsewhere?), volume / size / EC / RO
//      counts, and the exact `weed shell` command that will run.
//   3. Execute. The shell streams stdout via SSE so operators see the
//      master's migration log live; ECProgressStream shows the same
//      "still waiting" heartbeat used by fix-replication / ec.* dialogs.
//
// Replaces the previous design which had two competing inputs (text +
// click), a `window.confirm` for the destructive step, and a blocking
// JSON request that froze the UI through a multi-minute drain.

import { useEffect, useMemo, useState } from "react";
import {
  LogOut, AlertTriangle, Play, Search, Server, HardDrive,
  ShieldCheck, ShieldAlert, X, ChevronRight,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { api, useVolumes, useDrains, type Volume } from "@/lib/api";
import { useCluster } from "@/lib/cluster-context";
import { useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { Can } from "@/components/can";
import { CommandPreview } from "@/components/cli/command-preview";
import { bytes as fmtBytes } from "@/lib/utils";
import Link from "next/link";

export default function LeavePage() {
  const { t } = useT();
  return (
    <Can
      cap="cluster.volume-server.leave"
      fallback={<div className="card p-6 text-sm text-muted">{t("You don't have permission to view this page.")}</div>}>
      <Inner/>
    </Can>
  );
}

// VolumeWithEC enriches the typed Volume with the EC fields the
// backend returns at runtime but doesn't surface in the type. Cast to
// this when reading IsEC so we don't need `as { IsEC?: boolean }` at
// every call site.
type VolumeWithEC = Volume & { IsEC?: boolean; Shards?: number[] };

// NodeStat is one row in the candidate list — pre-aggregated per
// server so the table can render without recomputing on every render
// and the safety checks have a single source of truth.
interface NodeStat {
  server: string;
  rack?: string;
  dataCenter?: string;
  volumes: number;            // total volume rows on this node (incl. EC shard bags)
  normalVolumes: number;      // non-EC volume rows
  ecShards: number;           // EC volume rows (each is one shard-bag)
  readOnly: number;           // R/O volume rows
  bytes: number;              // sum of Size
  soleCopies: number;         // non-EC volumes that exist ONLY on this node
}

function Inner() {
  const { t } = useT();
  const { clusterID, setClusterID } = useCluster();
  const { data: vd } = useVolumes(clusterID);

  const [selectedNode, setSelectedNode] = useState<string>("");

  // Allow deep links from the topology page: ?cluster=<id>&node=<host:port>.
  // Read from window.location in effect instead of useSearchParams so the
  // page doesn't trip the Next.js prerender Suspense requirement.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const p = new URLSearchParams(window.location.search);
    const qc = p.get("cluster") || "";
    const qn = p.get("node") || "";
    if (qc && qc !== clusterID) setClusterID(qc);
    if (qn) setSelectedNode(qn);
    // run once on mount; subsequent changes are driven by user clicks
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [force, setForce] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [running, setRunning] = useState(false);
  const [reason, setReason] = useState("");
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState<"volumes" | "bytes" | "server">("volumes");
  const router = useRouter();
  // Surface in-flight drains on the picker page itself — if there's
  // already one running for this cluster, the operator probably wants
  // to follow that one rather than start a duplicate.
  const { data: liveDrains } = useDrains(clusterID, "pending,running,verifying");

  // Build per-node aggregates. We do the replica-safety check here too:
  // for every non-EC volume on a node, count how many distinct servers
  // hold the SAME volume id. If only this one — it's a sole copy and
  // draining loses data unless force is suppressed.
  const nodes: NodeStat[] = useMemo(() => {
    const items = (vd?.items as VolumeWithEC[] | undefined) || [];
    // 1st pass: build "where each volume lives". EC shards live on
    // many nodes by definition so we only track normal volumes here.
    const homes = new Map<number, Set<string>>();
    for (const v of items) {
      if (v.IsEC) continue;
      const s = homes.get(v.ID) ?? new Set<string>();
      s.add(v.Server);
      homes.set(v.ID, s);
    }
    // 2nd pass: aggregate per node.
    const m = new Map<string, NodeStat>();
    for (const v of items) {
      const cur = m.get(v.Server) ?? {
        server: v.Server,
        rack: v.Rack,
        dataCenter: v.DataCenter,
        volumes: 0, normalVolumes: 0, ecShards: 0,
        readOnly: 0, bytes: 0, soleCopies: 0,
      };
      cur.volumes++;
      cur.bytes += Number(v.Size) || 0;
      if (v.ReadOnly) cur.readOnly++;
      if (v.IsEC) cur.ecShards++;
      else {
        cur.normalVolumes++;
        if ((homes.get(v.ID)?.size ?? 0) <= 1) cur.soleCopies++;
      }
      m.set(v.Server, cur);
    }
    return [...m.values()];
  }, [vd]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? nodes.filter(n =>
          n.server.toLowerCase().includes(q)
          || (n.rack || "").toLowerCase().includes(q)
          || (n.dataCenter || "").toLowerCase().includes(q))
      : nodes;
    const sorted = [...list];
    sorted.sort((a, b) => {
      switch (sortBy) {
        case "bytes":  return b.bytes - a.bytes;
        case "server": return a.server.localeCompare(b.server);
        default:       return b.volumes - a.volumes;
      }
    });
    return sorted;
  }, [nodes, query, sortBy]);

  const selected = nodes.find(n => n.server === selectedNode);

  const previewArgs = useMemo<string[]>(() => {
    const a: string[] = [];
    if (selectedNode) a.push(`-node=${selectedNode}`);
    if (force) a.push("-force");
    return a;
  }, [selectedNode, force]);

  // Two confirmations gate the destructive step. The first is the
  // checkbox / button enablement. The second is typing the host:port —
  // operators can't drain the wrong server by misclicking the run button.
  const typedConfirm = confirmText.trim() === selectedNode;
  const canRun = !!selected && typedConfirm && !running;

  // Submit creates a durable drain job and navigates to the detail
  // page so the operator can walk away. The detail page tails the
  // same SSE the runner publishes to; closing the browser tab no
  // longer cancels the drain.
  const submit = async () => {
    if (!selected || !typedConfirm || !clusterID) return;
    setRunning(true);
    try {
      const { id } = await api.createDrain(clusterID, {
        node: selectedNode,
        force,
        reason: reason.trim(),
      });
      router.push(`/clusters/drains/${id}`);
    } catch (e) {
      toast.fromError(e, t("Failed to start drain"));
      setRunning(false);
    }
  };

  if (!clusterID) {
    return (
      <div className="card p-6 text-sm text-muted">
        {t("Pick a cluster in the topbar to start.")}
      </div>
    );
  }

  return (
    <div className="space-y-5 max-w-6xl">
      {/* ───────── Page header ───────── */}
      <header>
        <h1 className="text-base font-semibold tracking-tight inline-flex items-center gap-2">
          <LogOut size={16}/> {t("Drain a volume server")}
        </h1>
        <p className="text-xs text-muted mt-1 max-w-2xl">
          {t("Run volumeServer.leave so the master migrates volumes off the node before you take it offline. Pick a node → review impact → confirm.")}
        </p>
      </header>

      {/* ───────── Step 1 — pick node ───────── */}
      <Step n={1} title={t("Pick a node")} done={!!selected}>
        <div className="card overflow-hidden">
          <div className="px-4 py-2 flex items-center gap-2 border-b border-border/60">
            <div className="relative flex-1 min-w-0 max-w-sm">
              <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none"/>
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder={t("filter by host / rack / DC")}
                className="input w-full pl-7 py-1 text-xs"/>
            </div>
            <div className="flex-1"/>
            <div className="text-[11px] text-muted">{t("Sort")}</div>
            {([
              ["volumes", t("Volumes")],
              ["bytes",   t("Size")],
              ["server",  t("Server")],
            ] as const).map(([k, label]) => (
              <button key={k}
                onClick={() => setSortBy(k)}
                className={`px-2 py-0.5 text-[11px] rounded ${
                  sortBy === k ? "bg-accent/15 text-accent" : "text-muted hover:bg-panel2"
                }`}>
                {label}
              </button>
            ))}
          </div>
          <div className="max-h-[24rem] overflow-auto">
            {filtered.length === 0 ? (
              <div className="p-8 text-center text-sm text-muted">
                <Server size={24} className="mx-auto mb-2 text-muted/40"/>
                {nodes.length === 0
                  ? t("No volume servers reported by this cluster.")
                  : t("No nodes match the filter.")}
              </div>
            ) : (
              <table className="grid w-full text-xs">
                <thead>
                  <tr>
                    <th className="text-left w-8"></th>
                    <th className="text-left">{t("Server")}</th>
                    <th className="text-left">{t("Rack")}</th>
                    <th className="text-right">{t("Volumes")}</th>
                    <th className="text-right">{t("EC")}</th>
                    <th className="text-right">{t("R/O")}</th>
                    <th className="text-right">{t("Size")}</th>
                    <th className="text-right">{t("Sole copies")}</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(n => {
                    const isSel = selectedNode === n.server;
                    const unsafe = n.soleCopies > 0;
                    return (
                      <tr
                        key={n.server}
                        role="button"
                        tabIndex={0}
                        aria-pressed={isSel}
                        onClick={() => setSelectedNode(n.server)}
                        onKeyDown={e => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setSelectedNode(n.server);
                          }
                        }}
                        className={`cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-accent transition-colors ${
                          isSel ? "bg-accent/10" : "hover:bg-panel2/50"
                        }`}>
                        <td>
                          <span className={`inline-flex items-center justify-center w-5 h-5 rounded-full border ${
                            isSel
                              ? "border-accent bg-accent/20 text-accent"
                              : "border-border text-transparent"
                          }`}>
                            <ChevronRight size={10}/>
                          </span>
                        </td>
                        <td className="font-mono">{n.server}</td>
                        <td className="text-muted">{n.rack || "—"}</td>
                        <td className="text-right tabular-nums">{n.volumes}</td>
                        <td className="text-right tabular-nums text-muted">
                          {n.ecShards || <span className="text-muted/40">0</span>}
                        </td>
                        <td className="text-right tabular-nums text-muted">
                          {n.readOnly || <span className="text-muted/40">0</span>}
                        </td>
                        <td className="text-right tabular-nums">{fmtBytes(n.bytes)}</td>
                        <td className={`text-right tabular-nums ${unsafe ? "text-danger font-semibold" : "text-success"}`}>
                          {unsafe ? n.soleCopies : "✓"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </Step>

      {/* ───────── Step 2 — impact preview ───────── */}
      <Step n={2} title={t("Review impact")} disabled={!selected} done={!!selected && !running}>
        {!selected ? (
          <div className="card p-4 text-xs text-muted">
            {t("Pick a node above to see what draining it will move.")}
          </div>
        ) : (
          <div className="space-y-3">
            {/* KPI strip — small tiles with one big number each. Bytes
                and EC counts get their own tile so capacity / EC impact
                are immediately visible. */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
              <Kpi icon={<HardDrive size={12}/>} label={t("Volumes")}    value={String(selected.normalVolumes)}/>
              <Kpi icon={<HardDrive size={12}/>} label={t("EC shards")}  value={String(selected.ecShards)}/>
              <Kpi icon={<HardDrive size={12}/>} label={t("Read-only")}  value={String(selected.readOnly)}/>
              <Kpi icon={<HardDrive size={12}/>} label={t("Size")}       value={fmtBytes(selected.bytes)}/>
              <Kpi
                icon={selected.soleCopies > 0 ? <ShieldAlert size={12}/> : <ShieldCheck size={12}/>}
                label={t("Sole copies")}
                value={String(selected.soleCopies)}
                tone={selected.soleCopies > 0 ? "danger" : "success"}/>
            </div>

            {/* Safety check banner. Sole-copy volumes mean data loss
                risk unless every replica policy has multi-copy. We
                highlight even when 0 because absence-of-warning is
                itself meaningful for a destructive operation. */}
            {selected.soleCopies > 0 ? (
              <div className="p-3 rounded border border-danger/40 bg-danger/5 text-sm">
                <div className="inline-flex items-center gap-2 text-danger font-medium">
                  <ShieldAlert size={14}/>
                  {t("{n} volume(s) on this node have NO replica elsewhere.").replace("{n}", String(selected.soleCopies))}
                </div>
                <div className="text-xs text-muted mt-1">
                  {t("Draining will move them — but if the migration fails or the cluster has no other space, you lose those volumes. Run volume.fix.replication first to make sure every volume has at least one peer copy.")}
                </div>
              </div>
            ) : (
              <div className="p-2 rounded border border-success/40 bg-success/5 text-xs text-success inline-flex items-center gap-2">
                <ShieldCheck size={14}/>
                {t("All volumes on this node have at least one replica elsewhere.")}
              </div>
            )}

            <CommandPreview command="volumeServer.leave" args={previewArgs}/>
          </div>
        )}
      </Step>

      {/* ───────── Step 3 — execute ───────── */}
      <Step n={3} title={t("Confirm and run")} disabled={!selected}>
        {!selected ? (
          <div className="card p-4 text-xs text-muted">
            {t("Select a node and review impact before running.")}
          </div>
        ) : (
          <div className="card p-4 space-y-3">
            {/* Force checkbox — escalated visual when checked: amber
                background + warning icon + explanatory help text. */}
            <label className={`flex items-start gap-2 p-2.5 rounded border cursor-pointer transition-colors ${
              force ? "border-warning/50 bg-warning/5" : "border-border/60 hover:border-border"
            }`}>
              <input
                type="checkbox"
                className="mt-0.5 accent-warning"
                checked={force}
                onChange={e => setForce(e.target.checked)}
                disabled={running}/>
              <div className="flex-1">
                <div className={`text-sm font-medium inline-flex items-center gap-1.5 ${force ? "text-warning" : ""}`}>
                  {force && <AlertTriangle size={12}/>}
                  {t("Force (don't wait for replicas to catch up)")}
                </div>
                <div className="text-[11px] text-muted mt-0.5">
                  {t("Only use this when the node is unreachable — the master will mark volumes lost if replicas haven't synced.")}
                </div>
              </div>
            </label>

            {/* Why this drain? Captured into the persistent record so
                an auditor can answer "who drained that rack and why"
                six months later. Free text, optional but encouraged. */}
            <div className="space-y-1">
              <label className="text-xs text-muted">{t("Reason (optional)")}</label>
              <textarea
                value={reason}
                onChange={e => setReason(e.target.value)}
                rows={2}
                placeholder={t("e.g. planned maintenance — replacing failing disk on rack r3")}
                className="input w-full text-sm"
                disabled={running}/>
            </div>

            {/* Type-to-confirm: the operator must echo the host:port so
                they can't mis-click the run button onto the wrong row. */}
            <div className="space-y-1">
              <label className="text-xs text-muted">
                {t("Type the node address to confirm")}
                <span className="text-danger ml-0.5">*</span>
              </label>
              <input
                value={confirmText}
                onChange={e => setConfirmText(e.target.value)}
                placeholder={selectedNode}
                className={`input w-full font-mono text-sm ${
                  confirmText && !typedConfirm ? "border-danger/60" : ""
                }`}
                disabled={running}
                autoComplete="off"/>
              {confirmText && !typedConfirm && (
                <div className="text-[11px] text-danger inline-flex items-center gap-1">
                  <X size={10}/>
                  {t("Doesn't match the selected node.")}
                </div>
              )}
            </div>

            <div className="flex items-center gap-2 pt-1">
              <button
                onClick={submit}
                disabled={!canRun}
                className={`btn inline-flex items-center gap-1.5 ${
                  canRun
                    ? force
                      ? "bg-danger/15 text-danger border-danger/40 hover:bg-danger/25"
                      : "btn-primary"
                    : "opacity-40 cursor-not-allowed"
                }`}>
                <Play size={14}/>
                {force
                  ? t("Force drain {node}").replace("{node}", selectedNode)
                  : t("Drain {node}").replace("{node}", selectedNode)}
              </button>
              <Link href="/clusters/drains" className="text-xs text-muted hover:text-text ml-auto">
                {t("View drain history")}
              </Link>
            </div>
          </div>
        )}
      </Step>

      {/* Active drains banner — surface any in-flight job for this
          cluster so the operator can resume tracking rather than
          starting a duplicate by accident. */}
      {liveDrains && liveDrains.items.length > 0 && (
        <section className="card p-3 border-accent/40 bg-accent/5 space-y-1.5">
          <div className="text-xs font-semibold inline-flex items-center gap-1.5 text-accent">
            <LogOut size={12}/> {t("In-flight drains")}
          </div>
          <ul className="space-y-1 text-xs">
            {liveDrains.items.map(d => (
              <li key={d.id} className="flex items-center justify-between">
                <span className="font-mono">{d.node}</span>
                <span className="text-muted">
                  {d.status} · {d.last_volumes}/{d.initial_volumes} {t("vols remaining")}
                </span>
                <Link href={`/clusters/drains/${d.id}`} className="text-accent hover:underline">
                  {t("Open")} →
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// Step is a numbered section wrapper. Numbered chevron on the left
// makes the linear flow obvious; disabled state dims downstream steps
// so the operator sees what's not yet ready.
function Step({
  n, title, children, disabled, done,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
  disabled?: boolean;
  done?: boolean;
}) {
  return (
    <section className={`space-y-2 ${disabled ? "opacity-60" : ""}`}>
      <div className="flex items-center gap-2">
        <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-semibold ${
          done
            ? "bg-success/15 text-success border border-success/30"
            : disabled
              ? "bg-bg border border-border text-muted"
              : "bg-accent/15 text-accent border border-accent/30"
        }`}>
          {n}
        </span>
        <h2 className="text-sm font-medium tracking-tight">{title}</h2>
      </div>
      {children}
    </section>
  );
}

// Kpi tile: large tabular number on top, label below. Tone shifts to
// danger/success when the metric itself carries semantic meaning
// (e.g. sole-copies > 0 should pop).
function Kpi({ icon, label, value, tone }: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone?: "success" | "danger";
}) {
  const toneText =
    tone === "danger" ? "text-danger"
    : tone === "success" ? "text-success"
    : "text-text";
  const toneBorder =
    tone === "danger" ? "border-danger/40 bg-danger/5"
    : tone === "success" ? "border-success/40 bg-success/5"
    : "border-border/60 bg-bg/30";
  return (
    <div className={`p-2 rounded border ${toneBorder}`}>
      <div className={`text-lg font-semibold tabular-nums ${toneText}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-muted inline-flex items-center gap-1">
        {icon} {label}
      </div>
    </div>
  );
}
