"use client";

// Path-scoped migration wizard. URL-driven: `?path=/foo` deep-links
// from the File Browser. Three panes top-to-bottom:
//   1. Filters — path, glob, min size, min age, recursive
//   2. Impact preview — file count, bytes, by-collection / by-extension
//      / by-age breakdown, sample files
//   3. AI proposals — drafts the operator can open in Ops console or
//      save as templates

import { useEffect, useState } from "react";
import {
  FolderTree, Sparkles, Loader2, AlertTriangle, ArrowRight, ScanLine, ListFilter,
} from "lucide-react";
import Link from "next/link";
import {
  api, usePricing, type PathPreviewResponse, type AIMigrationProposal, type BackendPricing,
} from "@/lib/api";
import { useCluster } from "@/lib/cluster-context";
import { useT } from "@/lib/i18n";
import { Can } from "@/components/can";
import { ErrorPanel } from "@/components/error-panel";
import { EmptyState } from "@/components/empty-state";
import { toast } from "@/lib/toast";
import { bytes as fmtBytes } from "@/lib/utils";
import { AIProposalActions } from "@/components/ai-proposal-actions";

export default function PathMigratePage() {
  const { t } = useT();
  return (
    <Can cap="file.read" fallback={
      <div className="card p-6 text-sm text-muted">{t("You don't have permission to view this page.")}</div>
    }>
      <Inner/>
    </Can>
  );
}

function Inner() {
  const { t } = useT();
  const { clusterID } = useCluster();
  const { data: pricing } = usePricing();
  const pricingItems = (pricing?.items ?? []) as BackendPricing[];

  // URL → state on mount only. Reflect back to URL on filter changes
  // so the wizard is deep-linkable. We don't use Next's useSearchParams
  // to avoid the prerender Suspense requirement.
  const [path, setPath] = useState("/");
  const [recursive, setRecursive] = useState(true);
  const [glob, setGlob] = useState("");
  const [minSizeMB, setMinSizeMB] = useState<string>("");
  const [minAgeDays, setMinAgeDays] = useState<string>("");
  const [targetBackend, setTargetBackend] = useState("");
  const [extraContext, setExtraContext] = useState("");

  useEffect(() => {
    if (typeof window === "undefined") return;
    const p = new URLSearchParams(window.location.search);
    const qp = p.get("path");
    if (qp && qp.startsWith("/")) setPath(qp);
    const qg = p.get("glob"); if (qg) setGlob(qg);
    const qr = p.get("recursive"); if (qr === "false") setRecursive(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.set("path", path);
    if (glob) url.searchParams.set("glob", glob); else url.searchParams.delete("glob");
    window.history.replaceState({}, "", url.toString());
  }, [path, glob]);

  const [preview, setPreview] = useState<PathPreviewResponse | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewErr, setPreviewErr] = useState<string>("");
  const [planning, setPlanning] = useState(false);
  const [proposals, setProposals] = useState<AIMigrationProposal[] | null>(null);
  const [planSummary, setPlanSummary] = useState("");

  if (!clusterID) {
    return (
      <div className="space-y-4">
        <Header t={t}/>
        <div className="card p-6 text-sm text-muted">{t("Pick a cluster in the top-right to start.")}</div>
      </div>
    );
  }

  const filterBody = () => ({
    path: path.trim() || "/",
    recursive,
    glob: glob.trim() || undefined,
    min_size_bytes: minSizeMB ? Math.round(Number(minSizeMB) * 1024 * 1024) : undefined,
    min_age_days: minAgeDays ? Number(minAgeDays) : undefined,
  });

  const runPreview = async () => {
    setPreviewing(true); setPreviewErr(""); setPreview(null); setProposals(null);
    try {
      const r = await api.pathMigratePreview(clusterID, filterBody());
      setPreview(r);
    } catch (e) {
      setPreviewErr((e as Error).message);
    } finally {
      setPreviewing(false);
    }
  };

  const askAI = async () => {
    if (!preview) {
      toast.warn(t("Run preview first so the AI sees the impact numbers."));
      return;
    }
    setPlanning(true); setProposals(null);
    try {
      const r = await api.pathMigrateAIPlan(clusterID, {
        ...filterBody(),
        target_backend: targetBackend || undefined,
        extra_context: extraContext || undefined,
        max_proposals: 3,
      });
      if (!r.ok) {
        toast.error(t("AI plan failed"), r.error ?? "");
        return;
      }
      setProposals(r.proposals ?? []);
      setPlanSummary(r.summary ?? "");
    } catch (e) {
      toast.fromError(e, t("AI plan failed"));
    } finally {
      setPlanning(false);
    }
  };

  return (
    <div className="space-y-4">
      <Header t={t}/>

      {/* ===== Filters ===== */}
      <section className="card p-4 space-y-3">
        <div className="text-xs font-semibold inline-flex items-center gap-1.5">
          <ListFilter size={12}/> {t("Scope")}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field label={t("Path")}>
            <input value={path} onChange={e => setPath(e.target.value)}
              className="input w-full font-mono text-sm" placeholder="/logs/2024"/>
          </Field>
          <Field label={t("Glob (filename pattern, e.g. *.log.gz)")}>
            <input value={glob} onChange={e => setGlob(e.target.value)}
              className="input w-full font-mono text-sm" placeholder="*"/>
          </Field>
          <Field label={t("Min file size (MB)")}>
            <input type="number" min="0" step="1" value={minSizeMB} onChange={e => setMinSizeMB(e.target.value)}
              className="input w-full font-mono text-sm" placeholder="0"/>
          </Field>
          <Field label={t("Min age (days)")}>
            <input type="number" min="0" step="1" value={minAgeDays} onChange={e => setMinAgeDays(e.target.value)}
              className="input w-full font-mono text-sm" placeholder="0"/>
          </Field>
        </div>
        <label className="inline-flex items-center gap-2 text-xs">
          <input type="checkbox" checked={recursive} onChange={e => setRecursive(e.target.checked)}/>
          {t("Recursive (walk subdirectories)")}
        </label>
        <div className="flex items-center gap-2 pt-1">
          <button onClick={runPreview} disabled={previewing}
            className="btn btn-primary inline-flex items-center gap-1.5 text-xs">
            {previewing ? <Loader2 size={12} className="animate-spin"/> : <ScanLine size={12}/>}
            {t("Run preview")}
          </button>
          <div className="text-[11px] text-muted">
            {t("Capped at 50k entries / depth 12. Filters apply during the walk.")}
          </div>
        </div>
      </section>

      {previewErr && <ErrorPanel error={previewErr}/>}

      {/* ===== Impact ===== */}
      {preview && <ImpactPanel t={t} preview={preview}/>}

      {/* ===== AI plan ===== */}
      {preview && preview.matched_files > 0 && (
        <Can cap="cost.write">
          <section className="card p-4 space-y-3">
            <div className="text-xs font-semibold inline-flex items-center gap-1.5">
              <Sparkles size={12} className="text-warning"/> {t("Ask AI to plan the migration")}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Field label={t("Preferred target backend (AI may override with rationale)")}>
                <select value={targetBackend} onChange={e => setTargetBackend(e.target.value)}
                  className="input w-full text-sm">
                  <option value="">{t("Let AI pick")}</option>
                  {pricingItems.filter(p => !p.is_hot_reference).map(p => (
                    <option key={p.id} value={p.name}>{p.display_name} ({p.kind} · {p.currency} {p.storage_price_per_tb_month}/TB/mo)</option>
                  ))}
                </select>
              </Field>
              <Field label={t("Extra context (optional)")}>
                <input value={extraContext} onChange={e => setExtraContext(e.target.value)}
                  className="input w-full text-sm"
                  placeholder={t("e.g. 'compliance requires 7-year retention'")}/>
              </Field>
            </div>
            <button onClick={askAI} disabled={planning}
              className="btn btn-primary inline-flex items-center gap-1.5 text-xs">
              {planning ? <Loader2 size={12} className="animate-spin"/> : <Sparkles size={12}/>}
              {t("Generate migration plan")}
            </button>
          </section>
        </Can>
      )}

      {/* ===== Proposals ===== */}
      {proposals !== null && (
        <ProposalsPanel t={t} summary={planSummary} proposals={proposals} clusterID={clusterID} pathHint={path}/>
      )}
    </div>
  );
}

// ---- bits ----

function Header({ t }: { t: (k: string) => string }) {
  return (
    <header>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-base font-semibold tracking-tight inline-flex items-center gap-2">
            <FolderTree size={20}/> {t("Path migration wizard")}
          </h1>
          <p className="text-xs text-muted mt-1 max-w-2xl">
            {t("Pick a path, see its impact, and ask the AI to draft a tiering plan for the data underneath. The wizard never executes migrations directly — proposals open in the Ops console for review.")}
          </p>
        </div>
        {/* Cross-link to rule-based migration surfaces in Automation.
            The user complaint was that "迁移" lived in two places with
            no link between them — these chips fix that without merging
            the groups. */}
        <div className="hidden md:flex flex-col gap-1 text-[11px] shrink-0">
          <span className="text-muted/70 uppercase tracking-wide text-[9px]">{t("Recurring instead?")}</span>
          <Link href="/lifecycle" className="badge hover:bg-panel2 transition-colors inline-flex items-center gap-1">
            {t("Lifecycle rules")} <ArrowRight size={10}/>
          </Link>
          <Link href="/policies" className="badge hover:bg-panel2 transition-colors inline-flex items-center gap-1">
            {t("Tiering policies")} <ArrowRight size={10}/>
          </Link>
        </div>
      </div>
    </header>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-[11px] text-muted">{label}</label>
      {children}
    </div>
  );
}

function ImpactPanel({ t, preview }: { t: (k: string) => string; preview: PathPreviewResponse }) {
  if (preview.matched_files === 0) {
    return (
      <EmptyState
        icon={FolderTree}
        title={t("No files matched")}
        hint={t("Walked {n} entries but none matched the filters. Adjust glob / size / age to broaden.")
          .replace("{n}", String(preview.walked))}
      />
    );
  }
  return (
    <section className="card overflow-hidden">
      <header className="px-3 py-2 border-b border-border flex items-center justify-between">
        <div className="text-xs font-semibold inline-flex items-center gap-2">
          <ScanLine size={12}/> {t("Impact")}
        </div>
        {preview.truncated && (
          <span className="badge text-[10px] border-warning/40 text-warning inline-flex items-center gap-1">
            <AlertTriangle size={10}/> {t("walk truncated")}
          </span>
        )}
      </header>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 p-4">
        <Tile label={t("Matched files")} value={preview.matched_files.toLocaleString()}/>
        <Tile label={t("Total bytes")} value={fmtBytes(preview.total_bytes)}/>
        <Tile label={t("Oldest mtime")} value={mtimeAgo(preview.oldest_mtime_seconds, t)}/>
        <Tile label={t("Newest mtime")} value={mtimeAgo(preview.newest_mtime_seconds, t)}/>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-border">
        <BreakdownList t={t} title={t("By collection")} rows={preview.by_collection.map(c => ({ label: c.collection, files: c.files, bytes: c.bytes }))}/>
        <BreakdownList t={t} title={t("By age")} rows={preview.by_age.map(a => ({ label: a.label, files: a.files, bytes: a.bytes }))}/>
        <BreakdownList t={t} title={t("By extension")} rows={preview.by_extension.map(e => ({ label: e.ext, files: e.files, bytes: e.bytes }))}/>
      </div>
      {preview.samples.length > 0 && (
        <details className="border-t border-border">
          <summary className="cursor-pointer px-3 py-2 text-xs text-muted hover:text-text">
            {t("Sample files ({n})").replace("{n}", String(preview.samples.length))}
          </summary>
          <ul className="px-3 pb-3 text-[11px] font-mono space-y-0.5">
            {preview.samples.map((s, i) => (
              <li key={i} className="flex justify-between gap-3">
                <span className="truncate text-muted">{s.FullPath}</span>
                <span className="text-muted/60 tabular-nums shrink-0">{fmtBytes(s.FileSize)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-center md:text-left">
      <div className="text-[10px] uppercase tracking-wide text-muted">{label}</div>
      <div className="text-lg font-semibold mt-0.5 tabular-nums">{value}</div>
    </div>
  );
}

function BreakdownList({ t, title, rows }: {
  t: (k: string) => string;
  title: string;
  rows: { label: string; files: number; bytes: number }[];
}) {
  if (rows.length === 0) return null;
  const maxBytes = Math.max(1, ...rows.map(r => r.bytes));
  return (
    <div className="p-3">
      <div className="text-[10px] uppercase tracking-wide text-muted mb-1.5">{title}</div>
      <ul className="space-y-1">
        {rows.slice(0, 10).map((r, i) => (
          <li key={i} className="text-[11px]">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono truncate">{r.label}</span>
              <span className="text-muted tabular-nums shrink-0">{fmtBytes(r.bytes)} · {r.files.toLocaleString()}</span>
            </div>
            <div className="h-0.5 bg-panel2 rounded overflow-hidden mt-0.5">
              <div className="h-full bg-accent" style={{ width: `${Math.max(2, (r.bytes / maxBytes) * 100)}%` }}/>
            </div>
          </li>
        ))}
        {rows.length > 10 && <li className="text-[10px] text-muted">+{rows.length - 10} {t("more")}</li>}
      </ul>
    </div>
  );
}

function ProposalsPanel({ t, summary, proposals, clusterID, pathHint }: {
  t: (k: string) => string;
  summary: string;
  proposals: AIMigrationProposal[];
  clusterID: string;
  pathHint: string;
}) {
  return (
    <section className="card overflow-hidden border-accent/40 bg-accent/[0.03]">
      <header className="px-3 py-2 border-b border-border inline-flex items-center gap-2 text-xs font-semibold">
        <Sparkles size={12} className="text-warning"/> {t("AI migration proposals for {path}").replace("{path}", pathHint)}
      </header>
      {summary && (
        <div className="px-3 py-2 text-xs text-muted border-b border-border italic">{summary}</div>
      )}
      {proposals.length === 0 ? (
        <div className="p-6 text-center text-xs text-muted">
          {t("The AI didn't find a worthwhile migration for this scope.")}
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {proposals.map((p, i) => (
            <li key={i} className="p-3 space-y-1.5">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium">{p.title}</div>
                  <div className="text-[11px] text-muted font-mono">
                    {p.collection || "(default)"} · {p.from_backend} → {p.to_backend} · {fmtBytes(p.bytes)}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-base font-semibold text-success tabular-nums">
                    {p.currency} {p.monthly_saving.toFixed(2)}/mo
                  </div>
                  <div className="text-[10px] inline-flex gap-1.5 mt-0.5">
                    <span className={`badge ${
                      p.risk === "high" ? "border-danger/40 text-danger"
                      : p.risk === "medium" ? "border-warning/40 text-warning"
                      : "border-success/40 text-success"
                    }`}>{t("risk")}: {t(p.risk)}</span>
                    <span className="badge border-muted/40 text-muted">{t("conf")}: {t(p.confidence)}</span>
                  </div>
                </div>
              </div>
              <p className="text-xs text-muted">{p.rationale}</p>
              {p.task_command && (
                <code className="block text-[11px] font-mono bg-black/30 p-2 rounded">{p.task_command}</code>
              )}
              <AIProposalActions clusterID={clusterID} proposal={p}/>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function mtimeAgo(secs: number, t: (k: string) => string): string {
  if (!secs) return "—";
  const d = (Date.now() / 1000) - secs;
  if (d < 60) return t("just now");
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  if (d < 86400 * 30) return `${Math.floor(d / 86400)}d`;
  return new Date(secs * 1000).toLocaleDateString();
}
