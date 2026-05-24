"use client";

// S3 Circuit Breaker — thin form over `s3.circuitBreaker`. The shell
// command supports enable/disable globally and per-bucket thresholds
// (type=Count|MB and value=threshold). We keep the UI simple:
// enable/disable toggle + a "list current settings" action +
// optional set-threshold form.
//
// AI advisor section: clicks "Get AI suggestion" → controller snapshots
// the current state, asks the configured AI provider for a single
// (type, value) proposal, displays it with a risk badge. Operator
// must explicitly click "Apply" — the proposal does not auto-apply.
// Decisions flow into the same counterfactual learning surface as the
// NL → IAM proposals.

import { useState } from "react";
import {
  Loader2, Play, Sparkles, Shield, ShieldAlert, ShieldCheck, CheckCircle2, AlertTriangle,
} from "lucide-react";
import { api } from "@/lib/api";
import { useCluster } from "@/lib/cluster-context";
import { useT } from "@/lib/i18n";
import { Can } from "@/components/can";
import { ErrorPanel } from "@/components/error-panel";
import { toast } from "@/lib/toast";

const TYPES = ["Count", "MB"];

type LimitProposal = {
  type: "Count" | "MB";
  value: number;
  risk: "low" | "medium" | "high";
  explanation: string;
};

export function CircuitBreakerPanel() {
  const { t } = useT();
  return (
    <Can cap="s3.circuit-breaker" fallback={<div className="card p-6 text-sm text-muted">{t("You don't have permission to view this page.")}</div>}>
      <Inner/>
    </Can>
  );
}

// Risk badge — same visual language as the NL → IAM card on Identities.
function RiskBadge({ risk }: { risk: "low" | "medium" | "high" }) {
  const cfg = {
    low:    { label: "Low risk",    cls: "bg-success/15 text-success border-success/30",  icon: ShieldCheck },
    medium: { label: "Medium risk", cls: "bg-warning/15 text-warning border-warning/30",  icon: Shield },
    high:   { label: "High risk",   cls: "bg-danger/15  text-danger  border-danger/30",   icon: ShieldAlert },
  } as const;
  const { label, cls, icon: Icon } = cfg[risk] ?? cfg.medium;
  const { t } = useT();
  return (
    <span className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] font-medium ${cls}`}>
      <Icon size={11}/> {t(label)}
    </span>
  );
}

// AILimitAdvisor — collapsible block at the top of the circuit-breaker
// page. Snapshots current state via the controller endpoint, shows the
// AI's single-line proposal, lets the operator apply it directly or
// edit before applying. Records the decision either way.
function AILimitAdvisor({ onApplied }: { onApplied: (output: string) => void }) {
  const { t } = useT();
  const { clusterID } = useCluster();
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const [proposal, setProposal]   = useState<LimitProposal | null>(null);
  const [proposalID, setProposalID] = useState<string | null>(null);
  const [warnings, setWarnings]   = useState<string[]>([]);
  const [editType, setEditType]   = useState<"Count" | "MB">("Count");
  const [editValue, setEditValue] = useState<string>("");
  const [applying, setApplying]   = useState(false);

  const reset = () => {
    setProposal(null);
    setProposalID(null);
    setWarnings([]);
    setError(null);
  };

  const generate = async () => {
    if (!clusterID) return;
    setLoading(true);
    reset();
    try {
      const res = await api.s3RecommendLimits(clusterID);
      if (!res.ok || !res.proposal) {
        setError(res.error ?? "AI did not return a proposal.");
        return;
      }
      setProposal(res.proposal);
      setProposalID(res.proposal_id ?? null);
      setWarnings(res.warnings ?? []);
      setEditType(res.proposal.type);
      setEditValue(String(res.proposal.value));
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  // Apply uses the existing s3CircuitBreaker handler ('set' action) —
  // this is the same code path the operator would use manually below.
  // We then send a decide() so the Learning panel sees the verdict.
  const apply = async () => {
    if (!proposal || !clusterID || !editValue.trim()) return;
    const finalType  = editType;
    const finalValue = Number(editValue);
    if (!Number.isFinite(finalValue) || finalValue <= 0) {
      toast.error(t("Value must be a positive number"));
      return;
    }
    setApplying(true);
    try {
      const r = await api.s3CircuitBreaker(clusterID, { action: "set", type: finalType, value: String(finalValue) });
      onApplied(r.output || "");
      toast.success(t("Limit applied"));
      if (proposalID) {
        const sameAsProposal = finalType === proposal.type && finalValue === proposal.value;
        api.s3LimitProposalDecide(proposalID, {
          decision:     sameAsProposal ? "approved" : "edited",
          applied_type:  finalType,
          applied_value: finalValue,
        }).catch(() => { /* best-effort */ });
      }
      reset();
    } catch (e: unknown) {
      toast.error(t("Apply failed"), (e as Error).message);
    } finally {
      setApplying(false);
    }
  };

  // Discard fires "discarded" verdict so the rejection rate is tracked.
  const discard = () => {
    if (proposalID) {
      api.s3LimitProposalDecide(proposalID, { decision: "discarded" }).catch(() => { /* best-effort */ });
    }
    reset();
  };

  if (!clusterID) return null;

  return (
    <section className="card overflow-hidden">
      <div className="px-4 py-3 flex items-center justify-between gap-3 border-b border-border/60">
        <span className="inline-flex items-center gap-2 text-sm font-medium">
          <Sparkles size={15} className="text-accent"/>
          {t("AI limit advisor")}
        </span>
        <button
          className="btn inline-flex items-center gap-1.5 bg-accent/15 text-accent border-accent/40"
          onClick={generate}
          disabled={loading}
        >
          {loading
            ? <><Loader2 size={13} className="animate-spin"/> {t("Generating…")}</>
            : <><Sparkles size={13}/> {t("Get AI suggestion")}</>}
        </button>
      </div>

      <div className="px-4 py-3 space-y-3">
        <p className="text-[11px] text-muted leading-relaxed">
          {t("The advisor reads current circuit-breaker state and trigger history, then proposes one threshold change. Review and apply explicitly — nothing auto-applies.")}
        </p>

        {error && (
          <div className="rounded border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger inline-flex items-start gap-2">
            <AlertTriangle size={13} className="mt-0.5 shrink-0"/> {error}
          </div>
        )}

        {proposal && (
          <div className="rounded-md border border-accent/30 bg-accent/[0.04] p-3 space-y-3">
            <div className="flex items-start justify-between gap-2 flex-wrap">
              <div className="text-xs font-medium inline-flex items-center gap-2">
                {t("Proposed limit")}: <code className="font-mono text-accent">{proposal.type} = {proposal.value.toLocaleString()}</code>
              </div>
              <RiskBadge risk={proposal.risk}/>
            </div>
            <p className="text-[11px] text-muted leading-relaxed">{proposal.explanation}</p>

            {warnings.length > 0 && (
              <ul className="text-[11px] text-warning space-y-0.5">
                {warnings.map((w, i) => (
                  <li key={i} className="inline-flex items-start gap-1">
                    <AlertTriangle size={11} className="mt-0.5 shrink-0"/> {w}
                  </li>
                ))}
              </ul>
            )}

            {/* Inline edit row — operator can tweak before applying.
                Editing here marks the decision as "edited" instead of
                "approved" when applied. */}
            <div className="grid grid-cols-12 gap-2">
              <div className="col-span-3">
                <label className="text-[10px] text-muted">{t("Type")}</label>
                <select className="select w-full" value={editType} onChange={e => setEditType(e.target.value as "Count" | "MB")}>
                  {TYPES.map(o => <option key={o} value={o}>{o}</option>)}
                </select>
              </div>
              <div className="col-span-5">
                <label className="text-[10px] text-muted">{t("Value")}</label>
                <input
                  type="number"
                  value={editValue}
                  onChange={e => setEditValue(e.target.value)}
                  className="input w-full font-mono"
                  min={1}
                />
              </div>
              <div className="col-span-4 flex items-end gap-2">
                <button
                  className="btn flex-1 inline-flex items-center justify-center gap-1.5 bg-success/15 text-success border-success/30"
                  onClick={apply}
                  disabled={applying || !editValue.trim()}
                >
                  {applying ? <Loader2 size={13} className="animate-spin"/> : <CheckCircle2 size={13}/>}
                  {t("Apply")}
                </button>
                <button className="btn text-muted" onClick={discard} disabled={applying}>
                  {t("Discard")}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function Inner() {
  const { t } = useT();
  const { clusterID } = useCluster();
  const [type, setType] = useState("Count");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState("");
  const [output, setOutput] = useState("");
  const [error, setError] = useState("");

  if (!clusterID) {
    return <div className="card p-6 text-sm text-muted">{t("Pick a cluster in the top-right to start.")}</div>;
  }

  const run = async (action: string, body: { action: string; type?: string; value?: string }) => {
    setBusy(action); setError(""); setOutput("");
    try {
      const r = await api.s3CircuitBreaker(clusterID, body);
      setOutput(r.output || t("Done — command finished with no output."));
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="space-y-5">
      {/* AI advisor — top of page so operators see it first. The
          Apply button inside writes through s3CircuitBreaker just like
          the manual form below, so we share the same output state. */}
      <AILimitAdvisor onApplied={setOutput}/>

      <section className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <button className="card p-4 text-left hover:bg-panel2/50 transition" onClick={() => run("list", { action: "list" })} disabled={!!busy}>
          <div className="text-xs uppercase tracking-wider text-muted mb-1">{t("List current")}</div>
          <div className="text-sm">{t("Show what is configured right now.")}</div>
        </button>
        <button className="card p-4 text-left border-success/30 hover:bg-success/5 transition" onClick={() => run("enable", { action: "enable" })} disabled={!!busy}>
          <div className="text-xs uppercase tracking-wider text-success mb-1">{t("Enable")}</div>
          <div className="text-sm">{t("Turn the circuit breaker on globally.")}</div>
        </button>
        <button className="card p-4 text-left border-danger/30 hover:bg-danger/5 transition" onClick={() => run("disable", { action: "disable" })} disabled={!!busy}>
          <div className="text-xs uppercase tracking-wider text-danger mb-1">{t("Disable")}</div>
          <div className="text-sm">{t("Turn it off. Use only when you know why.")}</div>
        </button>
      </section>

      <section className="card p-4 space-y-3">
        <h2 className="text-sm font-medium">{t("Set a threshold")}</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="space-y-1">
            <label className="text-[11px] text-muted">{t("Type")}</label>
            <select className="select w-full" value={type} onChange={e => setType(e.target.value)}>
              {TYPES.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-[11px] text-muted">{t("Value")} <span className="text-danger">*</span></label>
            <input value={value} onChange={e => setValue(e.target.value)} placeholder="1000" className="input w-full font-mono"/>
          </div>
          <div className="flex items-end">
            <button className="btn w-full inline-flex items-center justify-center gap-1.5 bg-accent/15 text-accent border-accent/40"
                    onClick={() => run("set", { action: "set", type, value })} disabled={!!busy || !value.trim()}>
              {busy === "set" ? <Loader2 size={14} className="animate-spin"/> : <Play size={14}/>} {t("Apply")}
            </button>
          </div>
        </div>
      </section>

      {error && <ErrorPanel error={error}/>}
      {output && (
        <section className="card p-3">
          <div className="text-xs uppercase tracking-wider text-muted mb-1">{t("Output")}</div>
          <pre className="text-[11px] font-mono whitespace-pre-wrap break-all max-h-72 overflow-auto">{output}</pre>
        </section>
      )}
    </div>
  );
}
