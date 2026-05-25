"use client";

// Activity — merges the former /tasks and /executions pages into one
// tabbed surface. Operators were toggling between the two often:
// "what's queued?" vs "what just finished?" are the same workflow, two
// time slices. Single page, ?tab= drives which slice is visible.

import { Suspense } from "react";
import { ListChecks, History, Globe2 } from "lucide-react";
import { TabsLayout } from "@/components/tabs-layout";
import { useT } from "@/lib/i18n";
import { useRunningCounts } from "@/lib/use-running-counts";
import { TasksPanel } from "./_panels/tasks";
import { ExecutionsPanel } from "./_panels/executions";
import { FleetOpsPanel } from "./_panels/fleet";

function ActivityInner() {
  const { t } = useT();
  const counts = useRunningCounts();
  // Pending + running on the Tasks tab; running executions on the Executions
  // tab — same counters the sidebar uses, surfaced here so the operator sees
  // load without scanning the rail.
  const tasksBadge = counts.pendingTasks + counts.runningTasks;
  const execBadge  = counts.runningExecutions;
  return (
    <TabsLayout
      title={<><ListChecks size={20}/> {t("Activity")}</>}
      subtitle={t("What the system is doing and what it has done.")}
      defaultTab="tasks"
      tabs={[
        {
          key: "fleet", label: "Fleet", icon: Globe2,
          panel: <FleetOpsPanel/>,
        },
        {
          key: "tasks", label: "Tasks", icon: ListChecks,
          badge: tasksBadge > 0 ? String(tasksBadge) : undefined,
          panel: <TasksPanel/>,
        },
        {
          key: "executions", label: "Executions", icon: History,
          badge: execBadge > 0 ? String(execBadge) : undefined,
          panel: <ExecutionsPanel/>,
        },
      ]}
    />
  );
}

export default function ActivityPage() {
  // TabsLayout reads useSearchParams which Next requires inside Suspense.
  return (
    <Suspense fallback={null}>
      <ActivityInner/>
    </Suspense>
  );
}
