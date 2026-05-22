"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { LogOut, Search, Server, Layers } from "lucide-react";
import { bytes } from "@/lib/utils";
import { useCaps } from "@/lib/caps-context";
import {
  ShellActionMenu, ShellActionDialog, type ShellAction,
} from "@/components/shell-action";

interface FlatNode {
  id: string;
  dc: string;
  rack: string;
  diskTypes: string[];
  volumeCount: number;
  maxVolumes: number;
  used: number;
  capacity: number;
  disks: any[];
}

interface NodeShellRow {
  id: string;
}

type SortKey = "server" | "rack" | "used" | "volumes" | "fill";
type GroupKey = "none" | "rack" | "dc";

const NODE_ACTIONS: ShellAction<NodeShellRow>[] = [
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

export function NodesPanel({ topo, clusterId }: { topo: any; clusterId: string }) {
  const all = useMemo(() => flattenTopology(topo), [topo]);
  const [q, setQ] = useState("");
  const [sortBy, setSortBy] = useState<SortKey>("fill");
  const [groupBy, setGroupBy] = useState<GroupKey>("none");

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const filtered = needle
      ? all.filter((n) =>
        n.id.toLowerCase().includes(needle)
        || n.rack.toLowerCase().includes(needle)
        || n.dc.toLowerCase().includes(needle))
      : all;
    const arr = [...filtered];
    arr.sort((a, b) => {
      switch (sortBy) {
        case "server": return a.id.localeCompare(b.id);
        case "rack": return (a.dc + a.rack).localeCompare(b.dc + b.rack);
        case "used": return b.used - a.used;
        case "volumes": return b.volumeCount - a.volumeCount;
        case "fill":
        default: return fillRatio(b) - fillRatio(a);
      }
    });
    return arr;
  }, [all, q, sortBy]);

  const grouped = useMemo(() => {
    if (groupBy === "none") return [{ key: "", label: "", nodes: rows }];
    const groups = new Map<string, FlatNode[]>();
    for (const node of rows) {
      const key = groupBy === "rack" ? `${node.dc} / ${node.rack}` : node.dc;
      const bucket = groups.get(key) || [];
      bucket.push(node);
      groups.set(key, bucket);
    }
    return [...groups.entries()].map(([key, nodes]) => ({ key, label: key, nodes }));
  }, [groupBy, rows]);

  if (!all.length) {
    return (
      <section className="card p-5">
        <h2 className="text-sm font-medium mb-2">Topology</h2>
        <div className="text-sm text-muted">Empty topology - master returned no data centers.</div>
      </section>
    );
  }

  return (
    <section className="card p-5 space-y-3">
      <header className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-sm font-medium">Topology</h2>
          <p className="text-[11px] text-muted mt-0.5">
            {all.length} nodes / {topo.totals?.volumes ?? 0} volumes /{" "}
            {bytes(topo.totals?.used)} / {bytes(topo.totals?.capacity)} used
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none"/>
            <input
              className="input w-56 pl-7 py-1 text-xs"
              placeholder="filter host / rack / DC"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <SegControl<GroupKey>
            value={groupBy}
            onChange={setGroupBy}
            options={[["none", "Flat"], ["rack", "By rack"], ["dc", "By DC"]]}
            icon={<Layers size={11}/>}
          />
          <SegControl<SortKey>
            value={sortBy}
            onChange={setSortBy}
            options={[
              ["fill", "% full"],
              ["used", "Used"],
              ["volumes", "Volumes"],
              ["server", "Server"],
              ["rack", "Rack"],
            ]}
          />
        </div>
      </header>

      <div className="border border-border/60 rounded-md overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-panel2/40 text-[10px] uppercase tracking-wider text-muted">
            <tr>
              <th className="text-left px-3 py-1.5 w-[28%]">Server</th>
              <th className="text-left px-2 py-1.5">DC / Rack</th>
              <th className="text-right px-2 py-1.5">Volumes</th>
              <th className="text-left px-2 py-1.5 w-[28%]">Usage</th>
              <th className="text-right px-2 py-1.5">Capacity</th>
              <th className="text-right px-3 py-1.5">Actions</th>
            </tr>
          </thead>
          <tbody>
            {grouped.map((group) => (
              <RowGroup key={group.key || "all"} label={group.label} nodes={group.nodes} clusterId={clusterId}/>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-muted">
                  <Server size={20} className="mx-auto mb-1.5 text-muted/40"/>
                  No nodes match the filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function flattenTopology(topo: any): FlatNode[] {
  const out: FlatNode[] = [];
  for (const dc of topo?.data_centers || []) {
    for (const rack of dc.racks || []) {
      for (const node of rack.nodes || []) {
        const disks: any[] = node.disks || [];
        const used = disks.reduce((sum, disk) => sum + (Number(disk.used) || 0), 0);
        const capacity = disks.reduce((sum, disk) => sum + (Number(disk.capacity) || 0), 0);
        const volumeCount = disks.reduce((sum, disk) => sum + (Number(disk.volume_count) || 0), 0);
        const maxVolumes = disks.reduce((sum, disk) => sum + (Number(disk.max_volumes) || 0), 0);
        const diskTypes = Array.from(new Set(disks.map((disk) => disk.type || "hdd")));
        out.push({
          id: node.id,
          dc: dc.id,
          rack: rack.id,
          diskTypes,
          volumeCount,
          maxVolumes,
          used,
          capacity,
          disks,
        });
      }
    }
  }
  return out;
}

function RowGroup({ label, nodes, clusterId }: { label: string; nodes: FlatNode[]; clusterId: string }) {
  return (
    <>
      {label && (
        <tr className="bg-bg/40">
          <td colSpan={6} className="px-3 py-1 text-[10px] uppercase tracking-wider text-muted border-t border-border/40">
            {label} <span className="text-muted/60">/ {nodes.length} nodes</span>
          </td>
        </tr>
      )}
      {nodes.map((node) => <NodeRow key={node.id} node={node} clusterId={clusterId}/>)}
    </>
  );
}

function NodeRow({ node, clusterId }: { node: FlatNode; clusterId: string }) {
  const [dialog, setDialog] = useState<{ action: ShellAction<NodeShellRow> } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const { me, has, loading } = useCaps();
  const row: NodeShellRow = { id: node.id };
  const ratio = fillRatio(node);
  const tone = ratio >= 0.9 ? "danger" : ratio >= 0.75 ? "warning" : "success";
  const canDrain = !loading && has("cluster.volume-server.leave");
  const canNodeShell = !loading && me?.role === "admin";
  const visibleActions = NODE_ACTIONS.filter((action) => {
    if (!canNodeShell) return false;
    if (action.key === "evacuate") return has("cluster.volume-server.leave");
    if (action.key === "balance-node") return has("volume.balance");
    return true;
  });

  return (
    <>
      <tr className="border-t border-border/40 hover:bg-panel2/40">
        <td className="px-3 py-2 align-middle">
          <div className="flex items-center gap-2">
            <Server size={11} className="text-muted shrink-0"/>
            <Link
              href={`/clusters/${clusterId}/volume-servers/${encodeURIComponent(node.id)}`}
              className="font-mono text-[11px] truncate hover:underline"
              title={node.id}
            >
              {node.id}
            </Link>
          </div>
          {node.diskTypes.length > 0 && (
            <div className="flex gap-1 mt-1">
              {node.diskTypes.map((diskType) => <span key={diskType} className="badge text-[10px] py-0">{diskType}</span>)}
            </div>
          )}
        </td>
        <td className="px-2 py-2 align-middle text-muted">
          <div>{node.dc}</div>
          <div className="text-[10px] text-muted/70">{node.rack}</div>
        </td>
        <td className="px-2 py-2 align-middle text-right tabular-nums">
          <div>{node.volumeCount}<span className="text-muted/70"> / {node.maxVolumes}</span></div>
          {node.disks.length > 1 && (
            <button
              onClick={() => setExpanded((value) => !value)}
              className="text-[10px] text-muted hover:text-accent"
            >
              {node.disks.length} disks {expanded ? "^" : "v"}
            </button>
          )}
        </td>
        <td className="px-2 py-2 align-middle">
          <div className="flex items-center gap-2">
            <div className="flex-1 h-1.5 rounded-full bg-panel2 overflow-hidden">
              <div className={`h-full ${barClassFor(tone)}`} style={{ width: `${Math.min(100, ratio * 100)}%` }}/>
            </div>
            <span className={`text-[11px] tabular-nums w-10 text-right ${textClassFor(tone)}`}>
              {(ratio * 100).toFixed(0)}%
            </span>
          </div>
        </td>
        <td className="px-2 py-2 align-middle text-right tabular-nums font-mono text-[11px]">
          {bytes(node.used)}
          <span className="text-muted/70"> / {bytes(node.capacity)}</span>
        </td>
        <td className="px-3 py-2 align-middle text-right">
          <div className="inline-flex items-center gap-1">
            {canDrain ? (
              <Link
                href={`/clusters/leave?cluster=${encodeURIComponent(clusterId)}&node=${encodeURIComponent(node.id)}`}
                title="Drain (volumeServer.leave)"
                className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded border border-warning/30 text-warning hover:bg-warning/10"
              >
                <LogOut size={11}/> Drain
              </Link>
            ) : null}
            {visibleActions.length > 0 ? (
              <ShellActionMenu row={row} actions={visibleActions} onPick={(action) => setDialog({ action })}/>
            ) : null}
          </div>
        </td>
      </tr>
      {expanded && node.disks.length > 1 && (
        <tr className="bg-bg/30">
          <td colSpan={6} className="px-3 py-2">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-1.5">
              {node.disks.map((disk: any, i: number) => {
                const diskRatio = disk.capacity ? (disk.used / disk.capacity) : 0;
                const diskTone = diskRatio >= 0.9 ? "danger" : diskRatio >= 0.75 ? "warning" : "success";
                return (
                  <div key={i} className="flex items-center gap-2 text-[11px]">
                    <span className="badge text-[10px] py-0">{disk.type || "hdd"}</span>
                    <span className="text-muted w-16 tabular-nums">{disk.volume_count}/{disk.max_volumes}</span>
                    <div className="flex-1 h-1 rounded-full bg-panel2 overflow-hidden">
                      <div className={`h-full ${barClassFor(diskTone)}`} style={{ width: `${Math.min(100, diskRatio * 100)}%` }}/>
                    </div>
                    <span className="font-mono text-[11px] w-28 text-right text-muted">
                      {bytes(disk.used)} / {bytes(disk.capacity)}
                    </span>
                  </div>
                );
              })}
            </div>
          </td>
        </tr>
      )}
      {dialog && (
        <tr>
          <td colSpan={6}>
            <ShellActionDialog
              clusterID={clusterId}
              row={row}
              action={dialog.action}
              onClose={() => setDialog(null)}
            />
          </td>
        </tr>
      )}
    </>
  );
}

function SegControl<T extends string>({
  value, onChange, options, icon,
}: {
  value: T;
  onChange: (value: T) => void;
  options: [T, string][];
  icon?: React.ReactNode;
}) {
  return (
    <div className="inline-flex items-center border border-border/60 rounded-md overflow-hidden">
      {icon && <span className="px-1.5 text-muted">{icon}</span>}
      {options.map(([key, label], i) => (
        <button
          key={key}
          onClick={() => onChange(key)}
          className={`px-2 py-1 text-[11px] transition-colors ${i > 0 ? "border-l border-border/60" : ""} ${value === key ? "bg-accent/15 text-accent" : "text-muted hover:bg-panel2"}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function fillRatio(node: FlatNode): number {
  return node.capacity > 0 ? node.used / node.capacity : 0;
}

function barClassFor(tone: "success" | "warning" | "danger") {
  return tone === "danger" ? "bg-danger" : tone === "warning" ? "bg-warning" : "bg-accent";
}

function textClassFor(tone: "success" | "warning" | "danger") {
  return tone === "danger" ? "text-danger" : tone === "warning" ? "text-warning" : "text-muted";
}
