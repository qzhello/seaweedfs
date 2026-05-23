"use client";

// S3 — merges the former /buckets, /s3/configure, /s3/circuit-breaker,
// and /s3/clean-uploads pages into one tabbed surface. They share the
// same operator domain (the S3 gateway), so collapsing the navigation
// rail and keeping URL state via ?tab= matches the /activity pattern.

import { Suspense } from "react";
import { Box, UserCog, Zap, Eraser } from "lucide-react";
import { TabsLayout } from "@/components/tabs-layout";
import { useT } from "@/lib/i18n";
import { BucketsPanel } from "./_panels/buckets";
import { IdentitiesPanel } from "./_panels/identities";
import { CircuitBreakerPanel } from "./_panels/circuit-breaker";
import { CleanUploadsPanel } from "./_panels/clean-uploads";

function S3Inner() {
  const { t } = useT();
  return (
    <TabsLayout
      title={<><Box size={20}/> {t("S3")}</>}
      subtitle={t("S3 gateway management: buckets, identities, circuit breaker, and stale-upload cleanup.")}
      defaultTab="buckets"
      tabs={[
        { key: "buckets",         label: "Buckets",         icon: Box,     panel: <BucketsPanel/> },
        { key: "identities",      label: "Identities",      icon: UserCog, panel: <IdentitiesPanel/> },
        { key: "circuit-breaker", label: "Circuit breaker", icon: Zap,     panel: <CircuitBreakerPanel/> },
        { key: "clean-uploads",   label: "Clean uploads",   icon: Eraser,  panel: <CleanUploadsPanel/> },
      ]}
    />
  );
}

export default function S3Page() {
  // TabsLayout reads useSearchParams which Next requires inside Suspense.
  return (
    <Suspense fallback={null}>
      <S3Inner/>
    </Suspense>
  );
}
