"use client";
import { bytes } from "@/lib/utils";
import { useCaps } from "@/lib/caps-context";
import { useClusterDetail } from "./_context";

export default function ClusterDetail() {
  const { has, loading } = useCaps();
  const { topology: topo, topologyError } = useClusterDetail();

  if (loading) return null;
  if (!has("cluster.read")) {
    return <div className="card p-6 text-sm text-muted">You do not have permission to view this cluster.</div>;
  }

  if (!topo) {
    return <TopologyUnavailable error={topologyError}/>;
  }

  return (
    <div className="space-y-6">
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Stat label="Data centers" value={topo.totals?.data_centers ?? 0}/>
        <Stat label="Nodes"         value={topo.totals?.nodes ?? 0}/>
        <Stat label="Volumes"       value={topo.totals?.volumes ?? 0}/>
        <Stat label="Used / Capacity" value={`${bytes(topo.totals?.used)} / ${bytes(topo.totals?.capacity)}`}
              sub={`${pct(topo.totals?.used, topo.totals?.capacity)} used`}/>
      </section>
    </div>
  );
}

function TopologyUnavailable({ error }: { error: string | null }) {
  return (
    <div className="card p-5 border-danger/40 bg-danger/10 text-danger">
      <div className="font-medium mb-1">Cannot reach SeaweedFS master</div>
      <div className="text-xs font-mono break-all">{error || "topology unavailable"}</div>
      <p className="text-xs text-muted mt-2">
        Cluster overview needs live topology from the master. Try again when the master is reachable.
      </p>
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

function pct(used: number, cap: number) {
  if (!cap) return "0%";
  return `${((used/cap)*100).toFixed(1)}%`;
}
