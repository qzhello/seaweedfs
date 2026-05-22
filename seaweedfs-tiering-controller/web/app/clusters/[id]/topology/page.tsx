"use client";

import { useCaps } from "@/lib/caps-context";
import { NodesPanel } from "../_components/nodes-panel";
import { useClusterDetail } from "../_context";

export default function ClusterTopologyPage() {
  const { has, loading } = useCaps();
  const { id, topology, topologyError } = useClusterDetail();
  if (loading) return null;
  if (!has("cluster.read")) {
    return <div className="card p-6 text-sm text-muted">You do not have permission to view this cluster topology.</div>;
  }
  if (!topology) {
    return (
      <div className="card p-5 border-danger/40 bg-danger/10 text-danger">
        <div className="font-medium mb-1">Cannot reach SeaweedFS master</div>
        <div className="text-xs font-mono break-all">{topologyError || "topology unavailable"}</div>
        <p className="text-xs text-muted mt-2">
          Topology requires a live master response. Try again when the cluster is reachable.
        </p>
      </div>
    );
  }
  return <NodesPanel topo={topology} clusterId={id}/>;
}
