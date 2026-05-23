"use client";

import { useCaps } from "@/lib/caps-context";
import { useT } from "@/lib/i18n";
import { ShellConsole } from "../_components/shell-console";
import { useClusterDetail } from "../_context";

export default function ClusterShellPage() {
  const { id, cluster } = useClusterDetail();
  const { me, loading } = useCaps();
  const { t } = useT();

  if (loading) return null;
  if (me?.role !== "admin") {
    return <div className="card p-6 text-sm text-muted">{t("You do not have permission to use this shell console.")}</div>;
  }

  return <ShellConsole clusterId={id} binPath={cluster?.weed_bin_path}/>;
}
