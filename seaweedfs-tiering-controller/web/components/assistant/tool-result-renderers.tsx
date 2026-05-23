"use client";

// Per-tool result renderers for the floating AI assistant. Each tool
// the model can call produces JSON; by default that JSON is shown
// raw inside an expandable card (ToolCallCard). For high-value tools
// we render a *deep-link card* instead — a small summary plus a
// button that lands the operator on the right page/tab.
//
// Why this exists: the assistant can already answer "alice has 4
// permissions" in text, but the operator's natural next step is to
// open Alice's identity row. Without deep links they have to scroll
// the chat, find the cluster, find the page, search for Alice. With
// deep links: click "Open identities" → land on /s3?tab=identities.
//
// Registry pattern: TOOL_RENDERERS maps tool name → component.
// Unknown / errored / still-running tools fall back to the default
// raw-JSON card. To add a new tool, add an entry to the registry —
// no changes elsewhere in the assistant code.
//
// Renderers SHOULD:
//   - Parse the JSON defensively (the model can be late / malformed)
//   - Return a single self-contained card with consistent borders
//   - Include a "Show raw" disclosure so operators can debug
//   - Use `next/link` so navigation stays SPA-snappy

import Link from "next/link";
import { useState } from "react";
import {
  Wrench, ChevronDown, ChevronUp, ExternalLink, Database, Server,
  Box, Key, ShieldAlert, Trash2, Thermometer, DollarSign, Network,
  ListChecks, FolderTree,
} from "lucide-react";
import { useT } from "@/lib/i18n";

// LiveTool mirrors the shape in floating-assistant.tsx — kept here as a
// minimal local interface so this file has no upward import.
interface LiveTool {
  id: string;
  name: string;
  arguments: string;
  result: string | null;
  isError: boolean;
}

interface RendererProps {
  call: LiveTool;
  parsed: unknown; // already JSON.parse'd result; never null here
}

// safeParse is duplicated rather than imported — keeps this file
// drop-in self-contained and avoids cross-imports with the main
// assistant component.
function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

// renderToolResult is the single entrypoint the assistant calls.
// Returns null when no specialised renderer applies, signalling the
// caller to use the default raw-JSON card.
export function renderToolResult(call: LiveTool): JSX.Element | null {
  // Errors / pending / unfinished calls always use the default card.
  if (call.isError || call.result === null) return null;
  const parsed = safeParse(call.result);
  if (!parsed || typeof parsed !== "object") return null;
  const Renderer = TOOL_RENDERERS[call.name];
  if (!Renderer) return null;
  return <Renderer call={call} parsed={parsed} />;
}

// ---- shared chrome ---------------------------------------------------

interface CardShellProps {
  tool: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  summary: React.ReactNode;
  actions: React.ReactNode;
  rawJSON: string;
}

// CardShell is the consistent look for every deep-link card: header
// with tool name + status, a 1-line summary, action buttons, and an
// optional "raw JSON" expander for debugging.
function CardShell({ tool, icon: Icon, summary, actions, rawJSON }: CardShellProps) {
  const { t } = useT();
  const [showRaw, setShowRaw] = useState(false);
  return (
    <div className="rounded-md border border-border bg-panel2/50 text-[11px] overflow-hidden">
      <div className="px-2.5 py-1.5 flex items-center gap-1.5 border-b border-border/60">
        <Icon size={12} className="text-accent shrink-0" />
        <span className="font-mono truncate">{tool}</span>
        <span className="text-muted">— {t("Done")}</span>
      </div>
      <div className="px-2.5 py-2 space-y-2">
        <div className="text-muted leading-relaxed">{summary}</div>
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
        <button
          type="button"
          onClick={() => setShowRaw(s => !s)}
          className="text-muted hover:text-text inline-flex items-center gap-0.5 text-[10px]"
        >
          {showRaw ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
          {showRaw ? t("Hide raw") : t("Show raw")}
        </button>
        {showRaw && (
          <pre className="text-[10px] font-mono whitespace-pre-wrap break-all bg-bg/40 rounded px-1.5 py-1 max-h-48 overflow-auto">
            {rawJSON}
          </pre>
        )}
      </div>
    </div>
  );
}

// LinkButton is a small consistent CTA used inside the action row.
function LinkButton({ href, icon: Icon, children }: {
  href: string;
  icon?: React.ComponentType<{ size?: number; className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1 rounded border border-accent/40 bg-accent/10 text-accent px-2 py-0.5 text-[10px] hover:bg-accent/15"
    >
      {Icon && <Icon size={10} />} {children} <ExternalLink size={9} />
    </Link>
  );
}

function safeFormat(s: string): string {
  try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; }
}

// ---- per-tool renderers ---------------------------------------------
//
// Each renderer is intentionally short. The pattern:
//   1. read a handful of fields out of `parsed`
//   2. build a 1-line summary
//   3. emit 1-2 LinkButtons pointing at the right page/tab
//   4. defer raw JSON to the disclosure
//
// Renderers MUST NOT throw on missing fields — the model can omit
// keys when its data was empty.

// list_buckets → /s3?tab=buckets
function ListBucketsCard({ call, parsed }: RendererProps) {
  const { t } = useT();
  const p = parsed as { cluster?: string; count?: number; buckets?: { name: string; quota_mb?: number; usage_pc?: number }[] };
  const total = p.count ?? p.buckets?.length ?? 0;
  const overQuota = (p.buckets ?? []).filter(b => (b.usage_pc ?? 0) >= 90).length;
  const noQuota = (p.buckets ?? []).filter(b => !b.quota_mb || b.quota_mb === 0).length;
  return (
    <CardShell tool={call.name} icon={Box} rawJSON={safeFormat(call.result!)}
      summary={
        <>
          {t("{n} bucket(s)").replace("{n}", String(total))}
          {overQuota > 0 && <> · <span className="text-danger">{t("{n} ≥90% quota").replace("{n}", String(overQuota))}</span></>}
          {noQuota > 0 && <> · <span className="text-warning">{t("{n} without quota").replace("{n}", String(noQuota))}</span></>}
          {p.cluster && <> · <span className="font-mono text-text">{p.cluster}</span></>}
        </>
      }
      actions={<LinkButton href="/s3?tab=buckets" icon={Box}>{t("Open Buckets")}</LinkButton>}
    />
  );
}

// get_bucket → /s3?tab=buckets (no per-bucket focus URL support yet)
function GetBucketCard({ call, parsed }: RendererProps) {
  const { t } = useT();
  const p = parsed as { name?: string; size_bytes?: number; quota_mb?: number; usage_pc?: number; owner?: string; cluster?: string };
  return (
    <CardShell tool={call.name} icon={Box} rawJSON={safeFormat(call.result!)}
      summary={
        <>
          <span className="font-mono text-text">{p.name ?? "?"}</span>
          {p.cluster && <> · {p.cluster}</>}
          {p.usage_pc != null && <> · {p.usage_pc.toFixed(1)}% {t("of quota")}</>}
          {p.owner && <> · {t("owner")} <span className="font-mono">{p.owner}</span></>}
        </>
      }
      actions={<LinkButton href="/s3?tab=buckets" icon={Box}>{t("Open Buckets")}</LinkButton>}
    />
  );
}

// list_s3_identities → /s3?tab=identities
function ListIdentitiesCard({ call, parsed }: RendererProps) {
  const { t } = useT();
  const p = parsed as { count?: number; identities?: { name: string; actions?: string[] }[]; cluster?: string };
  const total = p.count ?? p.identities?.length ?? 0;
  const adminCount = (p.identities ?? []).filter(i => (i.actions ?? []).includes("Admin")).length;
  return (
    <CardShell tool={call.name} icon={Key} rawJSON={safeFormat(call.result!)}
      summary={
        <>
          {t("{n} identity(s)").replace("{n}", String(total))}
          {adminCount > 0 && <> · <span className="text-warning">{t("{n} with Admin").replace("{n}", String(adminCount))}</span></>}
          {p.cluster && <> · <span className="font-mono text-text">{p.cluster}</span></>}
        </>
      }
      actions={<LinkButton href="/s3?tab=identities" icon={Key}>{t("Open Identities")}</LinkButton>}
    />
  );
}

// get_circuit_breaker → /s3?tab=circuit-breaker
function GetCircuitBreakerCard({ call, parsed }: RendererProps) {
  const { t } = useT();
  const p = parsed as { cluster?: string; note?: string };
  return (
    <CardShell tool={call.name} icon={ShieldAlert} rawJSON={safeFormat(call.result!)}
      summary={p.note ? <>{p.note}</> : <>{t("Circuit breaker configuration on {c}").replace("{c}", p.cluster ?? "?")}</>}
      actions={<LinkButton href="/s3?tab=circuit-breaker" icon={ShieldAlert}>{t("Open Circuit Breaker")}</LinkButton>}
    />
  );
}

// list_clean_uploads → /s3?tab=clean-uploads
function ListCleanUploadsCard({ call, parsed }: RendererProps) {
  const { t } = useT();
  const p = parsed as { count?: number; truncated?: boolean; uploads?: { age_hours?: number; size_so_far?: number }[] };
  const uploads = p.uploads ?? [];
  const total = p.count ?? uploads.length;
  const oldest = uploads.reduce((m, u) => Math.max(m, u.age_hours ?? 0), 0);
  const totalSize = uploads.reduce((s, u) => s + (u.size_so_far ?? 0), 0);
  return (
    <CardShell tool={call.name} icon={Trash2} rawJSON={safeFormat(call.result!)}
      summary={
        <>
          {t("{n} stuck upload(s)").replace("{n}", String(total))}
          {total > 0 && <> · {t("oldest")} {oldest}h · {(totalSize / 1_048_576).toFixed(1)} MB</>}
          {p.truncated && <> · <span className="text-warning">{t("truncated")}</span></>}
        </>
      }
      actions={<LinkButton href="/s3?tab=clean-uploads" icon={Trash2}>{t("Open Clean Uploads")}</LinkButton>}
    />
  );
}

// list_clusters → /clusters
function ListClustersCard({ call, parsed }: RendererProps) {
  const { t } = useT();
  const p = parsed as { clusters?: { id: string; name: string }[] };
  const total = p.clusters?.length ?? 0;
  return (
    <CardShell tool={call.name} icon={Server} rawJSON={safeFormat(call.result!)}
      summary={t("{n} cluster(s) registered").replace("{n}", String(total))}
      actions={<LinkButton href="/clusters" icon={Server}>{t("Open Clusters")}</LinkButton>}
    />
  );
}

// list_volumes → /volumes (best-effort; the page accepts cluster query)
function ListVolumesCard({ call, parsed }: RendererProps) {
  const { t } = useT();
  const p = parsed as { cluster_id?: string; volumes?: { id: number; ec?: boolean }[] };
  const total = p.volumes?.length ?? 0;
  const ec = (p.volumes ?? []).filter(v => v.ec).length;
  const href = p.cluster_id ? `/volumes?cluster=${encodeURIComponent(p.cluster_id)}` : "/volumes";
  return (
    <CardShell tool={call.name} icon={Database} rawJSON={safeFormat(call.result!)}
      summary={
        <>
          {t("{n} volume(s)").replace("{n}", String(total))}
          {ec > 0 && <> · {t("{n} EC").replace("{n}", String(ec))}</>}
        </>
      }
      actions={<LinkButton href={href} icon={Database}>{t("Open Volumes")}</LinkButton>}
    />
  );
}

// get_temperature → /temperature
function GetTemperatureCard({ call, parsed }: RendererProps) {
  const { t } = useT();
  const p = parsed as { collections?: unknown[] };
  return (
    <CardShell tool={call.name} icon={Thermometer} rawJSON={safeFormat(call.result!)}
      summary={t("Temperature data for {n} collection(s)").replace("{n}", String(p.collections?.length ?? 0))}
      actions={<LinkButton href="/temperature" icon={Thermometer}>{t("Open Temperature")}</LinkButton>}
    />
  );
}

// get_costs → /costs
function GetCostsCard({ call, parsed }: RendererProps) {
  const { t } = useT();
  const p = parsed as { cluster?: string; total_monthly_usd?: number };
  return (
    <CardShell tool={call.name} icon={DollarSign} rawJSON={safeFormat(call.result!)}
      summary={
        <>
          {p.cluster && <><span className="font-mono text-text">{p.cluster}</span> · </>}
          {p.total_monthly_usd != null && <>${p.total_monthly_usd.toFixed(0)}/{t("mo")}</>}
        </>
      }
      actions={<LinkButton href="/costs" icon={DollarSign}>{t("Open Costs")}</LinkButton>}
    />
  );
}

// get_capacity_forecast → /clusters
function GetCapacityForecastCard({ call, parsed }: RendererProps) {
  const { t } = useT();
  const p = parsed as { clusters?: { name: string; fill_pc?: number; days_to_full?: number }[] };
  const tight = (p.clusters ?? []).filter(c => (c.days_to_full ?? Infinity) < 30).length;
  return (
    <CardShell tool={call.name} icon={Network} rawJSON={safeFormat(call.result!)}
      summary={
        <>
          {t("{n} cluster(s) tracked").replace("{n}", String(p.clusters?.length ?? 0))}
          {tight > 0 && <> · <span className="text-danger">{t("{n} under 30 days").replace("{n}", String(tight))}</span></>}
        </>
      }
      actions={<LinkButton href="/clusters" icon={Network}>{t("Open Clusters")}</LinkButton>}
    />
  );
}

// list_capacity_incidents → /reliability
function ListCapacityIncidentsCard({ call, parsed }: RendererProps) {
  const { t } = useT();
  const p = parsed as { incidents?: { id: string; status?: string }[] };
  const open = (p.incidents ?? []).filter(i => i.status !== "resolved").length;
  return (
    <CardShell tool={call.name} icon={ShieldAlert} rawJSON={safeFormat(call.result!)}
      summary={
        <>
          {t("{n} incident(s)").replace("{n}", String(p.incidents?.length ?? 0))}
          {open > 0 && <> · <span className="text-danger">{t("{n} open").replace("{n}", String(open))}</span></>}
        </>
      }
      actions={<LinkButton href="/reliability" icon={ShieldAlert}>{t("Open Reliability")}</LinkButton>}
    />
  );
}

// list_skills / get_skill → /skills
function ListSkillsCard({ call, parsed }: RendererProps) {
  const { t } = useT();
  const p = parsed as { skills?: { key: string }[] };
  return (
    <CardShell tool={call.name} icon={Wrench} rawJSON={safeFormat(call.result!)}
      summary={t("{n} skill(s) available").replace("{n}", String(p.skills?.length ?? 0))}
      actions={<LinkButton href="/skills" icon={Wrench}>{t("Open Skills")}</LinkButton>}
    />
  );
}

function GetSkillCard({ call, parsed }: RendererProps) {
  const { t } = useT();
  const p = parsed as { key?: string; name?: string; risk_level?: string };
  return (
    <CardShell tool={call.name} icon={Wrench} rawJSON={safeFormat(call.result!)}
      summary={
        <>
          <span className="font-mono text-text">{p.key ?? "?"}</span>
          {p.name && <> — {p.name}</>}
          {p.risk_level && <> · {p.risk_level} {t("risk")}</>}
        </>
      }
      actions={<LinkButton href="/skills" icon={Wrench}>{t("Open Skills")}</LinkButton>}
    />
  );
}

// path_preview → /path-migrate
function PathPreviewCard({ call, parsed }: RendererProps) {
  const { t } = useT();
  const p = parsed as { matched_files?: number; total_bytes?: number; path?: string };
  return (
    <CardShell tool={call.name} icon={FolderTree} rawJSON={safeFormat(call.result!)}
      summary={
        <>
          {p.path && <span className="font-mono text-text">{p.path}</span>}
          {p.matched_files != null && <> · {p.matched_files.toLocaleString()} {t("files")}</>}
          {p.total_bytes != null && <> · {(p.total_bytes / 1_073_741_824).toFixed(2)} GB</>}
        </>
      }
      actions={<LinkButton href="/path-migrate" icon={FolderTree}>{t("Open Path migrate")}</LinkButton>}
    />
  );
}

// list_capacity_incidents handled above; this is the registry itself.
const TOOL_RENDERERS: Record<string, React.ComponentType<RendererProps>> = {
  // S3 surface (new, Tier 1.1)
  list_buckets:           ListBucketsCard,
  get_bucket:             GetBucketCard,
  list_s3_identities:     ListIdentitiesCard,
  get_circuit_breaker:    GetCircuitBreakerCard,
  list_clean_uploads:     ListCleanUploadsCard,
  // Pre-existing high-value tools
  list_clusters:          ListClustersCard,
  list_volumes:           ListVolumesCard,
  get_temperature:        GetTemperatureCard,
  get_costs:              GetCostsCard,
  get_capacity_forecast:  GetCapacityForecastCard,
  list_capacity_incidents:ListCapacityIncidentsCard,
  list_skills:            ListSkillsCard,
  get_skill:              GetSkillCard,
  path_preview:           PathPreviewCard,
  // toggle_skill / propose_skill keep their existing dedicated cards.
};

// Use this just to anchor the type expectation — the registry must be
// keyed by tool name and yield a renderer.
export type ToolRendererRegistry = typeof TOOL_RENDERERS;
