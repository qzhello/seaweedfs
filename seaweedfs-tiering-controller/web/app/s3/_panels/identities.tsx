"use client";

// S3 Identities — manages access keys and per-bucket permissions
// via `weed shell s3.configure`. Operators add/edit identities
// without touching the underlying identities.json directly.
//
// Each identity has: name, optional credentials, action list.
// Actions are strings like "Read", "Write", "List", "Tagging",
// "Admin" — or scoped form like "Read:bucket-name" to limit to one
// bucket. We render the actions as tag chips with type-to-add.

import { useState } from "react";
import { TableSkeleton } from "@/components/table-skeleton";
import useSWR from "swr";
import { UserCog, Plus, Trash2, Save, AlertTriangle, Loader2, Eye, EyeOff, X, ChevronDown, ChevronRight, Sparkles, ShieldCheck, ShieldAlert, Shield, CheckCircle2 } from "lucide-react";
import { api } from "@/lib/api";
import { confirm as confirmDlg } from "@/lib/confirm";
import { useCluster } from "@/lib/cluster-context";
import { useT } from "@/lib/i18n";
import { Can } from "@/components/can";
import { ErrorPanel } from "@/components/error-panel";
import { toast } from "@/lib/toast";

type Cred = { accessKey: string; secretKey: string };
type Ident = { name: string; credentials?: Cred[]; actions?: string[] };

const COMMON_ACTIONS = ["Read", "Write", "List", "Tagging", "Admin"];

export function IdentitiesPanel() {
  const { t } = useT();
  return (
    <Can cap="s3.configure" fallback={<div className="card p-6 text-sm text-muted">{t("You don't have permission to view this page.")}</div>}>
      <Inner/>
    </Can>
  );
}

// ---- AI policy assistant types ----

type PolicyProposal = {
  actions: string[];
  buckets: string[];
  explanation: string;
  risk: "low" | "medium" | "high";
};

// sameActionSet treats action lists as unordered sets so reordering
// doesn't count as an "edit". Used to distinguish "approved as-is"
// from "approved with tweaks" in the AI Learning panel.
function sameActionSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  for (const x of b) if (!sa.has(x)) return false;
  return true;
}

// ---- Risk badge helper ----

function RiskBadge({ risk }: { risk: "low" | "medium" | "high" }) {
  const config = {
    low:    { label: "Low risk",    cls: "bg-success/15 text-success border-success/30",   icon: ShieldCheck },
    medium: { label: "Medium risk", cls: "bg-warning/15 text-warning border-warning/30",   icon: Shield },
    high:   { label: "High risk",   cls: "bg-danger/15  text-danger  border-danger/30",    icon: ShieldAlert },
  } as const;
  const { label, cls, icon: Icon } = config[risk] ?? config.medium;
  return (
    <span className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] font-medium ${cls}`}>
      <Icon size={11} /> {label}
    </span>
  );
}

// ---- AI Policy Assistant panel ----

function AIPolicyAssistant({ onApprove }: { onApprove: (p: PolicyProposal, proposalID: string | null) => void }) {
  const { clusterID } = useCluster();
  const [expanded, setExpanded] = useState(false);
  const [prompt, setPrompt]     = useState("");
  const [hint, setHint]         = useState("");
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [proposal, setProposal] = useState<PolicyProposal | null>(null);
  // The proposal_id from the backend — we need it to record the
  // operator's decision (approved/discarded/edited) for the AI Learning
  // panel. Null if the backend skipped logging (e.g. PG transient).
  const [proposalID, setProposalID] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  const generate = async () => {
    if (!clusterID || !prompt.trim()) return;
    setLoading(true);
    setError(null);
    setProposal(null);
    setProposalID(null);
    setWarnings([]);
    try {
      const res = await api.s3NLPolicy(clusterID, { prompt: prompt.trim(), scope_hint: hint.trim() || undefined });
      if (!res.ok || !res.proposal) {
        setError(res.error ?? "AI did not return a proposal.");
        return;
      }
      setProposal(res.proposal);
      setProposalID(res.proposal_id ?? null);
      setWarnings(res.warnings ?? []);
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  // discardLocal clears the panel without logging. discardWithDecision
  // records "discarded" on the backend so the learning panel can
  // measure rejection rate. We log fire-and-forget — a failure to
  // record shouldn't block the operator from moving on.
  const discardLocal = () => {
    setProposal(null);
    setProposalID(null);
    setWarnings([]);
    setError(null);
  };
  const discardWithDecision = () => {
    if (proposalID) {
      api.s3NLPolicyDecide(proposalID, { decision: "discarded" }).catch(() => { /* best-effort */ });
    }
    discardLocal();
  };

  return (
    <div className="card overflow-hidden">
      {/* Collapsible header */}
      <button
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-surface/60 transition-colors"
        onClick={() => setExpanded(s => !s)}
        aria-expanded={expanded}
      >
        <span className="inline-flex items-center gap-2 text-sm font-medium">
          <Sparkles size={15} className="text-accent" />
          AI policy assistant
        </span>
        {expanded ? <ChevronDown size={15} className="text-muted" /> : <ChevronRight size={15} className="text-muted" />}
      </button>

      {expanded && (
        <div className="border-t border-border px-4 pb-4 pt-3 space-y-3">
          <p className="text-[11px] text-muted leading-relaxed">
            Describe your access goal in plain English. The AI will propose a minimal SeaweedFS S3 IAM policy.
            You must review and explicitly approve before it is applied.
          </p>

          {/* Prompt textarea */}
          <div className="space-y-1">
            <label className="text-[11px] text-muted">Goal</label>
            <textarea
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              rows={3}
              placeholder="read-only access to logs-* buckets, no delete"
              className="input w-full resize-none font-mono text-xs"
            />
          </div>

          {/* Optional scope hint */}
          <div className="space-y-1">
            <label className="text-[11px] text-muted">Bucket scope hint <span className="text-muted/60">(optional prefix)</span></label>
            <input
              value={hint}
              onChange={e => setHint(e.target.value)}
              placeholder="logs-"
              className="input w-full font-mono text-xs"
            />
          </div>

          <div>
            <button
              className="btn inline-flex items-center gap-1.5 bg-accent/15 text-accent border-accent/40"
              onClick={generate}
              disabled={loading || !prompt.trim()}
            >
              {loading
                ? <><Loader2 size={13} className="animate-spin" /> Generating…</>
                : <><Sparkles size={13} /> Generate</>
              }
            </button>
          </div>

          {/* Error */}
          {error && (
            <div className="rounded border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger inline-flex items-start gap-2">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Proposal card */}
          {proposal && (
            <div className="rounded-lg border border-border bg-surface/60 p-4 space-y-3">
              {/* Header row */}
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="text-xs font-medium">Proposed policy</span>
                <RiskBadge risk={proposal.risk} />
              </div>

              {/* Explanation */}
              <p className="text-[11px] text-muted leading-relaxed">{proposal.explanation}</p>

              {/* Actions */}
              <div className="space-y-1">
                <span className="text-[11px] font-medium text-muted">Actions</span>
                <div className="flex flex-wrap gap-1">
                  {proposal.actions.map(a => (
                    <span key={a} className="badge text-[10px] bg-accent/10 text-accent border-accent/30">{a}</span>
                  ))}
                </div>
              </div>

              {/* Buckets */}
              <div className="space-y-1">
                <span className="text-[11px] font-medium text-muted">
                  Buckets {proposal.buckets.length === 0 && <span className="text-warning">(all buckets)</span>}
                </span>
                {proposal.buckets.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {proposal.buckets.map(b => (
                      <span key={b} className="badge font-mono text-[10px]">{b}</span>
                    ))}
                  </div>
                )}
              </div>

              {/* Warnings */}
              {warnings.length > 0 && (
                <ul className="space-y-1">
                  {warnings.map((w, i) => (
                    <li key={i} className="text-[10px] text-warning inline-flex items-start gap-1.5">
                      <AlertTriangle size={11} className="mt-0.5 shrink-0" /> {w}
                    </li>
                  ))}
                </ul>
              )}

              {/* Action buttons */}
              <div className="flex gap-2 pt-1">
                <button
                  className="btn inline-flex items-center gap-1.5 bg-success/15 text-success border-success/30 text-xs"
                  onClick={() => { onApprove(proposal, proposalID); discardLocal(); }}
                >
                  <CheckCircle2 size={13} /> Approve &amp; create identity
                </button>
                <button
                  className="btn text-xs text-muted"
                  onClick={discardWithDecision}
                >
                  Discard
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---- Key rotation reminder ----
//
// Surfaces identities whose access keys haven't been touched (via the
// controller) in N days. The summary chip is the headline; expanding
// shows the per-identity list with age, so the operator can decide
// where to rotate. Deliberately silent when there's nothing to flag —
// we don't want to add another permanent box to the page.

const ROTATION_THRESHOLD_DAYS = 180;

function KeyRotationReminder() {
  const { t } = useT();
  const { clusterID } = useCluster();
  const [expanded, setExpanded] = useState(false);
  const swrKey = clusterID ? `s3-identity-rotation:${clusterID}` : null;
  const { data } = useSWR(
    swrKey,
    () => api.s3IdentityRotation(clusterID, ROTATION_THRESHOLD_DAYS),
    { revalidateOnFocus: false }
  );

  if (!data) return null;
  // Nothing actionable → render nothing. The signal is the absence of
  // a card, not a "you're good!" green box.
  if (data.stale_count === 0 && data.unknown_count === 0) return null;

  const stale   = data.identities.filter(i => i.status === "stale");
  const unknown = data.identities.filter(i => i.status === "unknown");

  return (
    <section className="card p-3 border-warning/30 bg-warning/5">
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="flex w-full items-center justify-between text-left"
      >
        <span className="inline-flex items-center gap-2 text-sm">
          <AlertTriangle size={14} className="text-warning"/>
          <span className="font-medium">{t("Key rotation reminder")}</span>
          <span className="text-muted">
            {data.stale_count > 0 && (
              <>
                <span className="font-mono text-warning">{data.stale_count}</span>{" "}
                {t("access key(s) not rotated in {n}+ days").replace("{n}", String(data.threshold_days))}
              </>
            )}
            {data.stale_count > 0 && data.unknown_count > 0 && " · "}
            {data.unknown_count > 0 && (
              <>
                <span className="font-mono">{data.unknown_count}</span>{" "}
                {t("with unknown age")}
              </>
            )}
          </span>
        </span>
        {expanded ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}
      </button>
      {expanded && (
        <div className="mt-3 space-y-3 text-xs">
          {stale.length > 0 && (
            <div>
              <div className="mb-1 font-medium text-warning">
                {t("Stale ({n})").replace("{n}", String(stale.length))}
              </div>
              <ul className="space-y-1">
                {stale.map(i => (
                  <li key={i.name} className="flex items-center justify-between rounded bg-panel2 px-2 py-1">
                    <span className="font-mono">{i.name}</span>
                    <span className="text-muted">
                      {t("{n} day(s) ago").replace("{n}", String(i.age_days ?? "?"))}
                      {" · "}
                      {i.access_key_count} {t("key(s)")}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {unknown.length > 0 && (
            <div>
              <div className="mb-1 font-medium text-muted">
                {t("Unknown rotation age ({n})").replace("{n}", String(unknown.length))}
              </div>
              <p className="mb-1 text-[11px] text-muted">
                {t("These identities exist in s3.configure but have never been edited through the controller. Their access keys may have been rotated via the CLI; the audit log doesn't know.")}
              </p>
              <ul className="space-y-1">
                {unknown.map(i => (
                  <li key={i.name} className="flex items-center justify-between rounded bg-panel2 px-2 py-1">
                    <span className="font-mono">{i.name}</span>
                    <span className="text-muted">{i.access_key_count} {t("key(s)")}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-[11px] text-muted">
            {t("Threshold")}: <span className="font-mono">{data.threshold_days}</span> {t("days")}.{" "}
            {t("\"Last rotated\" is the most recent identity edit recorded in the audit log; a secret-only rotation done via CLI is invisible here.")}
          </p>
        </div>
      )}
    </section>
  );
}

// ---- Main panel ----

function Inner() {
  const { t } = useT();
  const { clusterID } = useCluster();
  const swrKey = clusterID ? `s3-identities:${clusterID}` : null;
  const { data, mutate, isLoading, error } = useSWR(swrKey, () => api.s3ListIdentities(clusterID));
  const [editing, setEditing] = useState<Ident | null>(null);

  if (!clusterID) {
    return <div className="card p-6 text-sm text-muted">{t("Pick a cluster in the top-right to start.")}</div>;
  }

  const identities = data?.identities || [];

  // Pending AI proposal — set when the operator clicks "Approve & create
  // identity" and cleared after the dialog closes. We keep the original
  // proposed actions so we can detect "edited" (operator approved the
  // direction but changed the action set before saving) vs "approved"
  // (saved exactly as proposed). Drives the AI Learning panel's
  // precision metric.
  const [pendingProposal, setPendingProposal] = useState<{
    id: string;
    actions: string[];
    buckets: string[];
  } | null>(null);

  const openFromProposal = (proposal: PolicyProposal, proposalID: string | null) => {
    setEditing({ name: "", actions: proposal.actions });
    if (proposalID) {
      setPendingProposal({ id: proposalID, actions: proposal.actions, buckets: proposal.buckets });
    }
  };

  // Called after EditDialog closes. If the close was triggered by a
  // successful save AND the dialog was initiated from an AI proposal,
  // record the decision with the final applied actions. "approved" when
  // the operator saved unchanged, "edited" when they tweaked the
  // proposal first.
  const handleDialogClose = async (didChange: boolean, applied?: { user: string; actions: string[] }) => {
    setEditing(null);
    if (didChange) await mutate();
    if (didChange && applied && pendingProposal) {
      const sameSet = sameActionSet(pendingProposal.actions, applied.actions);
      api.s3NLPolicyDecide(pendingProposal.id, {
        decision: sameSet ? "approved" : "edited",
        applied_actions: applied.actions,
        applied_buckets: pendingProposal.buckets,
        applied_user:    applied.user,
      }).catch(() => { /* best-effort */ });
    }
    setPendingProposal(null);
  };

  return (
    <div className="space-y-5">
      {/* Key rotation reminder — small, dismissible-by-design (only renders when there's something to say) */}
      <KeyRotationReminder />

      {/* AI policy assistant — collapsible, at the top */}
      <AIPolicyAssistant onApprove={openFromProposal} />

      <div className="flex items-center justify-end">
        <button className="btn inline-flex items-center gap-1.5" onClick={() => setEditing({ name: "", actions: ["Read"] })}>
          <Plus size={14}/> {t("New identity")}
        </button>
      </div>

      {error && <ErrorPanel error={error}/>}
      {data?.parse_error && (
        <div className="card p-3 text-xs text-warning border-warning/30 bg-warning/10 inline-flex items-center gap-2">
          <AlertTriangle size={14}/> {t("Could not parse identities; showing empty list.")} <code className="font-mono">{data.parse_error}</code>
        </div>
      )}

      <section className="card overflow-hidden">
        {isLoading
          ? <TableSkeleton rows={5} cols={5}/>
          : identities.length === 0
            ? <div className="p-10 text-center text-sm text-muted">{t("No identities yet. Click 'New identity' above to create one.")}</div>
            : (
              <table className="grid w-full text-xs">
                <thead>
                  <tr>
                    <th className="text-left">{t("Name")}</th>
                    <th className="text-left">{t("Access keys")}</th>
                    <th className="text-left">{t("Actions")}</th>
                    <th className="text-right">{t("Actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {identities.map(i => (
                    <tr key={i.name}>
                      <td className="font-mono">{i.name}</td>
                      <td className="font-mono text-muted">{i.credentials?.length || 0}</td>
                      <td>
                        <div className="flex flex-wrap gap-1">
                          {(i.actions || []).map(a => <span key={a} className="badge text-[10px]">{a}</span>)}
                        </div>
                      </td>
                      <td className="text-right space-x-2">
                        <button className="btn text-xs" onClick={() => setEditing(i)}>{t("Edit")}</button>
                        <button className="btn text-xs bg-danger/15 text-danger border-danger/40"
                                onClick={async () => {
                                  if (!(await confirmDlg.danger({ title: t("Delete identity {n}?").replace("{n}", i.name) }))) return;
                                  try { await api.s3DeleteIdentity(clusterID, i.name); toast.success("Deleted"); await mutate(); }
                                  catch (e) { toast.fromError(e, "Delete failed"); }
                                }}>
                          <Trash2 size={12}/>
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
      </section>

      {editing && (
        <EditDialog
          identity={editing}
          clusterID={clusterID}
          onClose={handleDialogClose}
        />
      )}
    </div>
  );
}

function EditDialog({
  identity, clusterID, onClose,
}: {
  identity: Ident;
  clusterID: string;
  // applied is set only on a successful save — Inner uses it to record
  // the AI-proposal decision (approved vs edited) for the Learning panel.
  onClose: (changed: boolean, applied?: { user: string; actions: string[] }) => void;
}) {
  const { t } = useT();
  const isNew = !identity.name;
  const [name, setName] = useState(identity.name);
  const [accessKey, setAccessKey] = useState(identity.credentials?.[0]?.accessKey || "");
  const [secretKey, setSecretKey] = useState("");
  const [actions, setActions] = useState<string[]>(identity.actions || []);
  const [revealSecret, setRevealSecret] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [actionInput, setActionInput] = useState("");

  const addAction = (a: string) => {
    const v = a.trim();
    if (!v) return;
    setActions(s => s.includes(v) ? s : [...s, v]);
    setActionInput("");
  };
  const removeAction = (a: string) => setActions(s => s.filter(x => x !== a));

  const save = async () => {
    if (!name.trim()) { setError(t("Name required")); return; }
    setBusy(true); setError("");
    try {
      const body: { user: string; access_key?: string; secret_key?: string; actions?: string[] } = {
        user: name.trim(),
        actions,
      };
      if (accessKey) body.access_key = accessKey;
      if (secretKey) body.secret_key = secretKey;
      await api.s3UpsertIdentity(clusterID, body);
      toast.success("Identity saved");
      onClose(true, { user: name.trim(), actions });
    } catch (e: unknown) {
      const msg = (e as Error).message;
      setError(msg);
      toast.error("Save failed", msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={() => !busy && onClose(false)}>
      <div className="card p-5 w-full max-w-xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-medium inline-flex items-center gap-2">
            <UserCog size={16}/> {isNew ? t("New identity") : t("Edit identity")} {!isNew && <span className="text-muted font-mono text-xs">· {identity.name}</span>}
          </h2>
          <button onClick={() => onClose(false)} className="p-1 text-muted hover:text-text"><X size={16}/></button>
        </div>

        <div className="space-y-3">
          <Field label={t("Name")} required>
            <input value={name} onChange={e => setName(e.target.value)} disabled={!isNew} placeholder="my-app" className="input w-full font-mono"/>
          </Field>
          <Field label={t("Access key")} hint={t("Optional. Leave blank if no key auth is needed.")}>
            <input value={accessKey} onChange={e => setAccessKey(e.target.value)} placeholder="AKIA..." className="input w-full font-mono"/>
          </Field>
          <Field label={t("Secret key")} hint={t("Only sent when set; previous secret stays untouched if left blank.")}>
            <div className="relative">
              <input
                type={revealSecret ? "text" : "password"}
                value={secretKey}
                onChange={e => setSecretKey(e.target.value)}
                placeholder="••••••"
                className="input w-full font-mono pr-9"
              />
              <button type="button" onClick={() => setRevealSecret(s => !s)} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-text" title={revealSecret ? "Hide" : "Show"}>
                {revealSecret ? <EyeOff size={14}/> : <Eye size={14}/>}
              </button>
            </div>
          </Field>
          <Field label={t("Actions")} hint={t("Add bare verbs (Read/Write/List/Tagging/Admin) or scope to a bucket with Read:bucket-name.")}>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {actions.map(a => (
                <span key={a} className="badge inline-flex items-center gap-1 text-[11px] cursor-pointer hover:bg-danger/15 hover:text-danger hover:border-danger/40" onClick={() => removeAction(a)}>
                  {a} <X size={10}/>
                </span>
              ))}
            </div>
            <div className="flex gap-2 mb-2">
              <input value={actionInput} onChange={e => setActionInput(e.target.value)} onKeyDown={e => e.key === "Enter" && (e.preventDefault(), addAction(actionInput))}
                placeholder="Read:my-bucket" className="input flex-1 font-mono"/>
              <button type="button" onClick={() => addAction(actionInput)} className="btn">{t("Add")}</button>
            </div>
            <div className="flex flex-wrap gap-1">
              {COMMON_ACTIONS.filter(a => !actions.includes(a)).map(a => (
                <button key={a} type="button" className="badge text-[10px] hover:bg-accent/15 hover:text-accent hover:border-accent/40" onClick={() => addAction(a)}>+ {a}</button>
              ))}
            </div>
          </Field>

          {error && <div className="text-xs text-danger inline-flex items-center gap-1"><AlertTriangle size={12}/> {error}</div>}

          <div className="flex justify-end gap-2 pt-2">
            <button className="btn" onClick={() => onClose(false)} disabled={busy}>{t("Cancel")}</button>
            <button className="btn bg-accent/15 text-accent border-accent/40 inline-flex items-center gap-1.5" onClick={save} disabled={busy}>
              {busy ? <Loader2 size={14} className="animate-spin"/> : <Save size={14}/>}
              {t("Save")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, required, children }: { label: string; hint?: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-[11px] text-muted">{label}{required && <span className="text-danger ml-1">*</span>}</label>
      {children}
      {hint && <p className="text-[10px] text-muted/80">{hint}</p>}
    </div>
  );
}
