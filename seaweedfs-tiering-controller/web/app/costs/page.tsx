"use client";

// Costs — merges the former /costs (Overview) and /pricing pages into one
// tabbed surface. Operators flip between "what am I spending?" (Overview)
// and "what are the unit rates?" (Pricing) constantly; tabs keep both a
// click apart and ?tab= drives which slice is visible.

import { Suspense } from "react";
import { DollarSign, Tags, Sparkles } from "lucide-react";
import { TabsLayout } from "@/components/tabs-layout";
import { useT } from "@/lib/i18n";
import { CostsOverviewPanel } from "./_panels/overview";
import { PricingPanel } from "./_panels/pricing";
import { BucketCostPlanPanel } from "./_panels/bucket-plan";

function CostsInner() {
  const { t } = useT();
  return (
    <TabsLayout
      title={<><DollarSign size={20}/> {t("Costs")}</>}
      subtitle={t("Tier-storage savings tracker and per-TB pricing table.")}
      defaultTab="overview"
      tabs={[
        {
          key: "overview", label: "Overview", icon: DollarSign,
          panel: <CostsOverviewPanel/>,
        },
        {
          key: "pricing", label: "Pricing", icon: Tags,
          panel: <PricingPanel/>,
        },
        {
          key: "bucket-plan", label: "Bucket plan (AI)", icon: Sparkles,
          panel: <BucketCostPlanPanel/>,
        },
      ]}
    />
  );
}

export default function CostsPage() {
  // TabsLayout reads useSearchParams which Next requires inside Suspense.
  return (
    <Suspense fallback={null}>
      <CostsInner/>
    </Suspense>
  );
}
