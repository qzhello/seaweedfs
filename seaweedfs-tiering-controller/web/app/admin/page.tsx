"use client";

// Admin — merges the former /settings, /settings/permissions, /audit,
// /ai-config and /ai-learning pages into one tabbed surface. All five
// are "operator who runs the system" tools: tune config, grant
// capabilities, prove who did what, wire up AI providers, and review
// past AI verdicts. One page, ?tab= drives which slice is visible.
//
// Why AI lives here and not at /ai: AI Config is system configuration
// (provider keys, defaults) and AI Learning is a retrospective audit
// of past verdicts — both fit Admin's "configure + review" mental
// model. The high-frequency operator surface stays at /activity.

import { Suspense } from "react";
import { Settings, SlidersHorizontal, Key, ScrollText, Sparkles, Brain, Coins } from "lucide-react";
import { TabsLayout } from "@/components/tabs-layout";
import { useT } from "@/lib/i18n";
import { SettingsPanel } from "./_panels/settings";
import { PermissionsPanel } from "./_panels/permissions";
import { AuditPanel } from "./_panels/audit";
import { AIConfigPanel } from "./_panels/ai-config";
import { AILearningPanel } from "./_panels/ai-learning";
import { AIUsagePanel } from "./_panels/ai-usage";

function AdminInner() {
  const { t } = useT();
  return (
    <TabsLayout
      title={<><Settings size={20}/> {t("Admin")}</>}
      subtitle={t("System configuration, role permissions, audit log, and AI provider setup.")}
      defaultTab="settings"
      tabs={[
        { key: "settings",    label: "Settings",    icon: SlidersHorizontal, panel: <SettingsPanel/> },
        { key: "permissions", label: "Permissions", icon: Key,               panel: <PermissionsPanel/> },
        { key: "audit",       label: "Audit",       icon: ScrollText,        panel: <AuditPanel/> },
        { key: "ai-config",   label: "AI Config",   icon: Sparkles,          panel: <AIConfigPanel/> },
        { key: "ai-learning", label: "AI Learning", icon: Brain,             panel: <AILearningPanel/> },
        { key: "ai-usage",    label: "AI Usage",    icon: Coins,             panel: <AIUsagePanel/> },
      ]}
    />
  );
}

export default function AdminPage() {
  // TabsLayout reads useSearchParams which Next requires inside Suspense.
  return (
    <Suspense fallback={null}>
      <AdminInner/>
    </Suspense>
  );
}
