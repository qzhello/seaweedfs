"use client";

// Cluster maintenance — merges the former /clusters/check-disk,
// /clusters/replication, /clusters/leave, and /clusters/drains pages
// into one tabbed surface. ?tab= drives which panel is visible so
// deep links and refreshes preserve the operator's place.

import { Suspense } from "react";
import { Wrench, HardDriveDownload, Copy, LogOut, History } from "lucide-react";
import { TabsLayout } from "@/components/tabs-layout";
import { useT } from "@/lib/i18n";
import { CheckDiskPanel } from "./_panels/check-disk";
import { ReplicationPanel } from "./_panels/replication";
import { DrainServerPanel } from "./_panels/drain-server";
import { DrainHistoryPanel } from "./_panels/drain-history";

function MaintenanceInner() {
  const { t } = useT();
  return (
    <TabsLayout
      title={<><Wrench size={20}/> {t("Cluster maintenance")}</>}
      subtitle={t("Disk check, replication setup, server drain, and drain history.")}
      defaultTab="check-disk"
      tabs={[
        { key: "check-disk",    label: "Check disk",    icon: HardDriveDownload, panel: <CheckDiskPanel/> },
        { key: "replication",   label: "Replication",   icon: Copy,              panel: <ReplicationPanel/> },
        { key: "drain-server",  label: "Drain server",  icon: LogOut,            panel: <DrainServerPanel/> },
        { key: "drain-history", label: "Drain history", icon: History,           panel: <DrainHistoryPanel/> },
      ]}
    />
  );
}

export default function ClusterMaintenancePage() {
  // TabsLayout reads useSearchParams which Next requires inside Suspense.
  return (
    <Suspense fallback={null}>
      <MaintenanceInner/>
    </Suspense>
  );
}
