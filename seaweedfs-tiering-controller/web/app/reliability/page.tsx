"use client";

// Reliability — merges the former /health, /alerts, and /safety pages
// into one tabbed surface. These three surfaces are the monitoring spine:
// health probes gate the scheduler, alerts get delivered when something
// breaks, and the emergency-stop / blocklist live under safety. One page,
// ?tab= drives which slice is visible.

import { Suspense } from "react";
import { Activity, Bell, ShieldAlert, ShieldCheck } from "lucide-react";
import { TabsLayout } from "@/components/tabs-layout";
import { useT } from "@/lib/i18n";
import { HealthPanel } from "./_panels/health";
import { AlertsPanel } from "./_panels/alerts";
import { SafetyPanel } from "./_panels/safety";

function ReliabilityInner() {
  const { t } = useT();
  return (
    <TabsLayout
      title={<><ShieldCheck size={20}/> {t("Reliability")}</>}
      subtitle={t("Health probes that gate the scheduler, alert delivery, and the emergency-stop switch.")}
      defaultTab="health"
      tabs={[
        { key: "health", label: "Health", icon: Activity, panel: <HealthPanel/> },
        { key: "alerts", label: "Alerts", icon: Bell, panel: <AlertsPanel/> },
        { key: "safety", label: "Safety", icon: ShieldAlert, panel: <SafetyPanel/> },
      ]}
    />
  );
}

export default function ReliabilityPage() {
  // TabsLayout reads useSearchParams which Next requires inside Suspense.
  return (
    <Suspense fallback={null}>
      <ReliabilityInner/>
    </Suspense>
  );
}
