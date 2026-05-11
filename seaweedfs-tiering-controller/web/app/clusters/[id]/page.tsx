"use client";
import { useClusterTopology, useClusterTags, api } from "@/lib/api";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, ChevronRight, ChevronDown, Tag, Trash2, Terminal, Loader2, AlertTriangle } from "lucide-react";
import { Breadcrumb } from "@/components/breadcrumb";
import { useState } from "react";
import { bytes } from "@/lib/utils";
import {
  ShellActionMenu, ShellActionDialog, type ShellAction,
} from "@/components/shell-action";

const DOMAINS = ["flight","train","hotel","car_rental","attraction","logs","finance","backup","other"];
const DTYPES  = ["", "metadata","media","log","report","compliance"];

export default function ClusterDetail() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { data: t, error } = useClusterTopology(id);
  const { data: tagData, mutate: refetchTags } = useClusterTags(id);

  if (error) {
    return (
      <div className="space-y-4">
        <button className="btn" onClick={() => router.back()}><ArrowLeft size={14}/> Back</button>
        <div className="card p-5 border-danger/40 bg-danger/10 text-danger">
          <div className="font-medium mb-1">Cannot reach SeaweedFS master</div>
          <div className="text-xs font-mono break-all">{String(error)}</div>
          <p className="text-xs text-muted mt-2">
            Cluster is saved, but the controller can't reach the master right now. You can configure other things under /skills or /ai-config and come back once the master is up.
          </p>
        </div>
      </div>
    );
  }
  if (!t) return <div className="text-muted">Loading…</div>;
  const cl = t.cluster;
  const topo = t.topology;

  return (
    <div className="space-y-6">
      <Breadcrumb items={[{ label: "Clusters", href: "/clusters" }, { label: cl.name }]}/>
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{cl.name}</h1>
          <p className="text-sm text-muted font-mono">{cl.master_addr}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="badge">{cl.business_domain}</span>
          <span className={`badge ${cl.enabled ? "border-success/40 text-success" : "border-muted text-muted"}`}>
            {cl.enabled ? "enabled" : "disabled"}
          </span>
        </div>
      </header>

      <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Stat label="Data centers" value={topo.totals?.data_centers ?? 0}/>
        <Stat label="Nodes"         value={topo.totals?.nodes ?? 0}/>
        <Stat label="Volumes"       value={topo.totals?.volumes ?? 0}/>
        <Stat label="Used / Capacity" value={`${bytes(topo.totals?.used)} / ${bytes(topo.totals?.capacity)}`}
              sub={`${pct(topo.totals?.used, topo.totals?.capacity)} used`}/>
      </section>

      <section className="card p-5">
        <h2 className="text-sm font-medium mb-3">Topology</h2>
        <div className="space-y-2">
          {topo.data_centers?.map((dc: any) => <DCNode key={dc.id} dc={dc} clusterId={id}/>)}
          {(!topo.data_centers || !topo.data_centers.length) &&
            <div className="text-sm text-muted">Empty topology — master returned no data centers.</div>}
        </div>
      </section>

      <section className="card p-5">
        <h2 className="text-sm font-medium mb-3 flex items-center gap-2"><Tag size={14}/> Tags</h2>
        <TagEditor clusterId={id} onSaved={refetchTags}/>
        <table className="grid mt-3">
          <thead><tr><th>Scope</th><th>Domain</th><th>Type</th><th>Holiday-sensitive</th><th>Notes</th><th></th></tr></thead>
          <tbody>
            {(tagData?.items || []).map((tag: any) => (
              <tr key={tag.id}>
                <td><span className="badge">{tag.scope_kind}</span> {tag.scope_value}</td>
                <td><span className="badge">{tag.business_domain}</span></td>
                <td>{tag.data_type || "—"}</td>
                <td>{tag.holiday_sensitive ? "yes" : "no"}</td>
                <td className="text-muted text-xs">{tag.notes}</td>
                <td className="text-right">
                  <button className="btn btn-danger" onClick={async () => {
                    await api.deleteTag(tag.id); await refetchTags();
                  }}><Trash2 size={14}/></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <ShellConsole clusterId={id} binPath={cl.weed_bin_path}/>
    </div>
  );
}

const SHELL_PRESETS: { label: string; command: string; args: string; mutating: boolean; help: string }[] = [
  // Read-only
  { label: "volume.list",            command: "volume.list",            args: "",                          mutating: false, help: "Dump all volumes per data-center / rack / node." },
  { label: "cluster.check",          command: "cluster.check",          args: "",                          mutating: false, help: "Master / volume server / filer reachability check." },
  { label: "cluster.ps",             command: "cluster.ps",             args: "",                          mutating: false, help: "List running shell sessions / locks." },
  { label: "volume.check.disk",      command: "volume.check.disk",      args: "-volumeId=1",               mutating: false, help: "Per-volume on-disk integrity scan. Replace 1 with the volume id." },
  // Mutating low risk
  { label: "volume.vacuum",          command: "volume.vacuum",          args: "-garbageThreshold=0.30",    mutating: true,  help: "Reclaim space from soft-deleted needles." },
  { label: "volume.fix.replication", command: "volume.fix.replication", args: "-apply",                    mutating: true,  help: "Bring replicas back to the configured replication code. Drop -apply for dry-run." },
  { label: "volume.balance",         command: "volume.balance",         args: "-force",                    mutating: true,  help: "Move volumes between nodes to even out usage." },
  { label: "volume.fsck",            command: "volume.fsck",            args: "",                          mutating: true,  help: "Full file-system check. Can be slow on big clusters." },
  // Per-volume mutating
  { label: "volume.mark -readonly",  command: "volume.mark",            args: "-volumeId=1 -node= -readonly", mutating: true, help: "Stop writes to a volume. Fill in -volumeId and -node before running." },
  { label: "volume.mark -writable",  command: "volume.mark",            args: "-volumeId=1 -node= -writable", mutating: true, help: "Re-enable writes." },
  { label: "volume.delete",          command: "volume.delete",          args: "-volumeId=1 -node= ",       mutating: true,  help: "Delete a single replica of a volume." },
  { label: "volume.move",            command: "volume.move",            args: "-volumeId=1 -source= -target= ", mutating: true, help: "Move a replica between nodes. Source/target = host:port." },
  { label: "volume.shrink",          command: "volume.shrink",          args: "-volumeId=1 -node= ",       mutating: true,  help: "Shrink the pre-allocated dat file to its actual used size." },
  { label: "ec.encode",              command: "ec.encode",              args: "-collection= -fullPercent=95 -quietFor=24h", mutating: true, help: "Convert eligible warm volumes into 10+4 EC shards." },
  { label: "ec.rebuild",             command: "ec.rebuild",             args: "-collection= -force",       mutating: true,  help: "Rebuild missing EC shards." },
];

function ShellConsole({ clusterId, binPath }: { clusterId: string; binPath?: string }) {
  const [preset, setPreset] = useState<typeof SHELL_PRESETS[number] | null>(null);
  const [args, setArgs] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [output, setOutput] = useState("");
  const [error, setError] = useState("");

  const applyPreset = (p: typeof SHELL_PRESETS[number]) => {
    setPreset(p);
    setArgs(p.args);
    setError("");
  };

  const run = async () => {
    if (!preset) return;
    if (preset.mutating && !reason.trim()) {
      setError("Mutating commands require a reason for the audit log.");
      return;
    }
    if (preset.mutating && !confirm(`Run mutating command\n  ${preset.command} ${args}\non cluster master?`)) {
      return;
    }
    setBusy(true);
    setOutput("");
    setError("");
    try {
      const r = await api.runClusterShell(clusterId, { command: preset.command, args, reason });
      const data = r as { output?: string; error?: string };
      if (data?.error) setError(data.error);
      setOutput(data?.output || "");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card p-5">
      <header className="flex items-center justify-between mb-3 gap-3">
        <h2 className="text-sm font-medium flex items-center gap-2">
          <Terminal size={14}/> Shell console
          <span className="text-xs text-muted font-normal">— allowlisted weed shell commands</span>
        </h2>
        <span className="text-[11px] text-muted font-mono truncate max-w-[280px]" title={binPath || "global"}>
          weed: {binPath || "global"}
        </span>
      </header>

      <div className="flex flex-wrap gap-1.5 mb-3">
        {SHELL_PRESETS.map(p => (
          <button key={p.label}
            onClick={() => applyPreset(p)}
            className={`text-xs px-2 py-1 rounded-md border transition-colors ${
              preset?.label === p.label
                ? "bg-accent/15 border-accent/40 text-accent"
                : p.mutating
                  ? "border-warning/30 text-warning hover:bg-warning/5"
                  : "border-border text-muted hover:text-text"
            }`}
            title={p.help}>
            {p.label}
          </button>
        ))}
      </div>

      {preset && (
        <div className="space-y-3 border-t border-border pt-3">
          <p className="text-xs text-muted">{preset.help}</p>
          <div className="grid grid-cols-1 md:grid-cols-[1fr_220px] gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">Args (verbatim, passed after the command name)</span>
              <input className="input w-full font-mono text-xs" value={args}
                onChange={e => setArgs(e.target.value)}/>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">Reason {preset.mutating && <span className="text-warning">(required)</span>}</span>
              <input className="input w-full text-xs" placeholder="why is this run needed"
                value={reason} onChange={e => setReason(e.target.value)}/>
            </label>
          </div>
          <div className="font-mono text-xs bg-bg/60 border border-border rounded px-2 py-1.5 text-muted">
            $ weed shell -master={"<this cluster>"} : <span className="text-text">{preset.command} {args}</span>
          </div>
          <div className="flex items-center gap-2">
            <button className="btn btn-primary" disabled={busy} onClick={run}>
              {busy ? <><Loader2 size={12} className="animate-spin"/> running…</> : "Run"}
            </button>
            {preset.mutating && (
              <span className="text-xs text-warning flex items-center gap-1">
                <AlertTriangle size={12}/> mutating — will be audited
              </span>
            )}
          </div>
        </div>
      )}

      {error && (
        <div className="mt-3 text-xs text-danger border border-danger/30 bg-danger/5 rounded px-2 py-1.5">
          {error}
        </div>
      )}
      {output && (
        <pre className="mt-3 font-mono text-[11px] bg-bg/60 border border-border rounded p-3 whitespace-pre-wrap max-h-[420px] overflow-auto">{output}</pre>
      )}
    </section>
  );
}

function DCNode({ dc, clusterId }: { dc: any; clusterId: string }) {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <button className="flex items-center gap-1 text-sm font-medium" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={14}/> : <ChevronRight size={14}/>} DC: {dc.id}
        <span className="text-muted text-xs ml-2">{dc.racks?.length || 0} racks</span>
      </button>
      {open && <div className="ml-5 mt-2 space-y-1">
        {dc.racks?.map((r: any) => <RackNode key={r.id} rack={r} clusterId={clusterId}/>)}
      </div>}
    </div>
  );
}

function RackNode({ rack, clusterId }: { rack: any; clusterId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button className="flex items-center gap-1 text-xs text-muted" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={12}/> : <ChevronRight size={12}/>} Rack: {rack.id}
        <span className="ml-2">{rack.nodes?.length || 0} nodes</span>
      </button>
      {open && <div className="ml-5 mt-1 space-y-1">
        {rack.nodes?.map((n: any) => <NodeRow key={n.id} node={n} clusterId={clusterId}/>)}
      </div>}
    </div>
  );
}

interface NodeShellRow { id: string }

const NODE_ACTIONS: ShellAction<NodeShellRow>[] = [
  // Drain a node so it can be taken offline. force triggers the actual
  // moves; without it the operator gets a dry-run summary.
  {
    key: "evacuate", label: "Drain (evacuate)", command: "volumeServer.evacuate", risk: "mutate",
    fields: [
      { key: "force", label: "Apply (skip dry-run)", default: "true", help: "Set to false to see what would move without doing it." },
      { key: "skipNonMoveable", label: "Skip non-moveable", default: "false", help: "True to ignore volumes that can't move (e.g. EC shards)." },
    ],
    buildArgs: (n, x) => {
      const parts = [`-node=${n.id}`];
      if ((x.force || "true") === "true") parts.push("-force");
      if (x.skipNonMoveable === "true") parts.push("-skipNonMoveable");
      return parts.join(" ");
    },
  },
  {
    key: "leave", label: "Mark as leaving", command: "volumeServer.leave", risk: "mutate",
    buildArgs: (n) => `-node=${n.id}`,
  },
  {
    key: "balance-node", label: "Balance volumes here", command: "volume.balance", risk: "mutate",
    fields: [
      { key: "collection", label: "Collection (optional)" },
      { key: "force", label: "Apply (skip dry-run)", default: "true" },
    ],
    buildArgs: (n, x) => {
      const parts = [`-nodes=${n.id}`];
      if (x.collection) parts.push(`-collection=${x.collection}`);
      if ((x.force || "true") === "true") parts.push("-force");
      return parts.join(" ");
    },
  },
  {
    key: "state", label: "Inspect runtime state", command: "volumeServer.state", risk: "read",
    buildArgs: (n) => `-node=${n.id}`,
  },
];

function NodeRow({ node, clusterId }: { node: any; clusterId: string }) {
  const [dialog, setDialog] = useState<{ action: ShellAction<NodeShellRow> } | null>(null);
  const row: NodeShellRow = { id: node.id };
  return (
    <div className="card p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs font-mono text-muted">{node.id}</div>
        <ShellActionMenu row={row} actions={NODE_ACTIONS} onPick={(a) => setDialog({ action: a })}/>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {node.disks?.map((d: any, i: number) => (
          <div key={i} className="flex items-center gap-2 text-xs">
            <span className="badge">{d.type || "hdd"}</span>
            <span className="text-muted w-20">{d.volume_count}/{d.max_volumes} vols</span>
            <div className="flex-1 h-1.5 rounded-full bg-panel2 overflow-hidden">
              <div className={`h-full ${barColor(d.used / d.capacity)}`} style={{ width: `${Math.min(100, (d.used/d.capacity)*100)}%` }}/>
            </div>
            <span className="font-mono text-xs w-32 text-right">{bytes(d.used)} / {bytes(d.capacity)}</span>
          </div>
        ))}
      </div>
      {dialog && (
        <ShellActionDialog
          clusterID={clusterId}
          row={row}
          action={dialog.action}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

function TagEditor({ clusterId, onSaved }: { clusterId: string; onSaved: () => void }) {
  const [t, setT] = useState({
    cluster_id: clusterId, scope_kind: "cluster", scope_value: "*",
    business_domain: "other", data_type: "", holiday_sensitive: false, notes: "",
  });
  return (
    <div className="grid grid-cols-7 gap-2 items-end">
      <Field label="Scope"><select className="input w-full" value={t.scope_kind}
        onChange={e => setT({ ...t, scope_kind: e.target.value })}>
        <option>cluster</option><option>collection</option><option>bucket</option>
      </select></Field>
      <Field label="Value"><input className="input w-full" value={t.scope_value}
        onChange={e => setT({ ...t, scope_value: e.target.value })}/></Field>
      <Field label="Domain"><select className="input w-full" value={t.business_domain}
        onChange={e => setT({ ...t, business_domain: e.target.value })}>
        {DOMAINS.map(d => <option key={d}>{d}</option>)}
      </select></Field>
      <Field label="Type"><select className="input w-full" value={t.data_type}
        onChange={e => setT({ ...t, data_type: e.target.value })}>
        {DTYPES.map(d => <option key={d}>{d || "—"}</option>)}
      </select></Field>
      <Field label="Holiday?"><input type="checkbox" className="self-start" checked={t.holiday_sensitive}
        onChange={e => setT({ ...t, holiday_sensitive: e.target.checked })}/></Field>
      <Field label="Notes"><input className="input w-full" value={t.notes}
        onChange={e => setT({ ...t, notes: e.target.value })}/></Field>
      <button className="btn btn-primary" onClick={async () => {
        await api.upsertTag(clusterId, { ...t, data_type: t.data_type || null });
        onSaved();
      }}>Add tag</button>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: any; sub?: any }) {
  return (
    <div className="card p-4">
      <div className="text-xs text-muted">{label}</div>
      <div className="text-xl font-semibold mt-1">{value}</div>
      {sub ? <div className="text-xs text-muted mt-1">{sub}</div> : null}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="flex flex-col gap-1"><span className="text-xs text-muted">{label}</span>{children}</label>;
}

function pct(used: number, cap: number) {
  if (!cap) return "0%";
  return `${((used/cap)*100).toFixed(1)}%`;
}
function barColor(ratio: number) {
  if (ratio >= 0.9) return "bg-danger";
  if (ratio >= 0.75) return "bg-warning";
  return "bg-accent";
}
