"use client";
import { useState } from "react";
import { Sparkles, Loader2, AlertCircle, ClipboardPaste, Wand2 } from "lucide-react";
import { api } from "@/lib/api";
import type { SOPDraft } from "@/components/sop-editor";

interface SkillImportCardProps {
  // Receives a draft when the user clicks "Use this draft" inside the card.
  // The parent (new-skill page) loads it into the SOPEditor.
  onApply: (draft: SOPDraft) => void;
}

type Mode = "json" | "ai";

// Card shown above the SOPEditor on /skills/new. Lets the operator either
// paste raw JSON (instant, no AI) or paste a free-form SOP that the AI
// converts into a skill draft. Result is staged inside the card so the
// operator can review before pushing it into the editor.
export function SkillImportCard({ onApply }: SkillImportCardProps) {
  const [mode, setMode] = useState<Mode>("ai");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>("");
  const [hintCategory, setHintCategory] = useState("");
  const [hintRisk, setHintRisk] = useState("");
  const [draft, setDraft] = useState<SOPDraft | null>(null);

  const convert = async () => {
    if (!text.trim()) return;
    setBusy(true);
    setError("");
    setDraft(null);
    try {
      const res = await api.draftSkillFromText({
        text,
        hint_category: hintCategory || undefined,
        hint_risk:     hintRisk     || undefined,
      }) as ConvertResp;
      if (!res?.ok || !res.draft) {
        setError(res?.error || "Conversion failed.");
        return;
      }
      const d = res.draft;
      setDraft({
        key:        d.key || "",
        name:       d.name || "",
        category:   d.category || "general",
        risk_level: (d.risk_level as SOPDraft["risk_level"]) || "low",
        change_note: res.mode === "ai" ? "Imported from AI conversion" : "Imported from JSON",
        definition: JSON.stringify(d.definition, null, 2),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "request failed");
    } finally {
      setBusy(false);
    }
  };

  const apply = () => {
    if (!draft) return;
    onApply(draft);
    // Keep the card content so the operator can re-import or tweak; just
    // clear the staged draft so the apply button doesn't re-fire.
    setDraft(null);
  };

  const placeholder = mode === "json"
    ? `Paste raw JSON. Either the full draft envelope
{
  "key": "custom.shrink",
  "name": "Shrink large volumes",
  "category": "maintenance",
  "risk_level": "medium",
  "definition": { ... }
}

…or just the definition body:
{
  "summary": "Shrink a read-only volume's slot footprint.",
  "preconditions": [...],
  "steps": [...]
}`
    : `Describe the SOP in any language. Example:

"Shrink under-utilized volumes. The volume must be read-only
and the cluster must be healthy. Acquire the volume lock, call
VolumeShrinkPreallocated with the target size, then verify the
volume still serves reads. On failure, roll back to the previous
size. Audit with action=shrink."`;

  return (
    <section className="card overflow-hidden">
      <header className="px-4 py-2.5 border-b border-border/60 flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-xs font-medium uppercase tracking-wider text-muted flex items-center gap-1.5">
          <ClipboardPaste size={12}/> Import from text
        </h2>
        <div className="inline-flex rounded-md border border-border overflow-hidden">
          {(["ai", "json"] as const).map(m => (
            <button key={m} type="button" onClick={() => { setMode(m); setError(""); setDraft(null); }}
              className={`px-2.5 py-1 text-xs transition-colors flex items-center gap-1 ${
                mode === m ? "bg-accent/15 text-accent" : "text-muted hover:bg-panel2 hover:text-text"
              }`}>
              {m === "ai" ? <><Sparkles size={11}/> AI convert</> : <><ClipboardPaste size={11}/> Paste JSON</>}
            </button>
          ))}
        </div>
      </header>

      <div className="p-4 space-y-3">
        <p className="text-xs text-muted">
          {mode === "ai"
            ? "Paste a free-form SOP — any language, prose or markdown. The configured AI provider converts it to a Skill draft you can review before saving."
            : "Paste a complete Skill JSON. The fast path: no AI involved, the JSON is validated and loaded straight into the editor."}
        </p>

        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder={placeholder}
          spellCheck={false}
          className="w-full h-44 font-mono text-xs bg-bg/60 border border-border rounded-md p-3 resize-y placeholder:text-muted/50 focus:outline-none focus:ring-2 focus:ring-accent/30"
        />

        {mode === "ai" && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-medium text-muted mb-1">Hint: category (optional)</label>
              <select className="select py-1 text-xs" value={hintCategory} onChange={e => setHintCategory(e.target.value)}>
                <option value="">— let AI pick —</option>
                {["tiering", "ec", "topology", "maintenance", "recovery", "integrity", "general"].map(c =>
                  <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-[11px] font-medium text-muted mb-1">Hint: risk level (optional)</label>
              <select className="select py-1 text-xs" value={hintRisk} onChange={e => setHintRisk(e.target.value)}>
                <option value="">— let AI pick —</option>
                {["low", "medium", "high", "critical"].map(r =>
                  <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
          </div>
        )}

        {error && (
          <div className="text-xs text-danger flex items-start gap-1.5 bg-danger/5 border border-danger/30 rounded-md px-3 py-2">
            <AlertCircle size={14} className="mt-0.5 shrink-0"/>
            <span className="break-all">{error}</span>
          </div>
        )}

        {draft && (
          <DraftPreview draft={draft} onApply={apply} onDiscard={() => setDraft(null)}/>
        )}

        <div className="flex items-center justify-between gap-3">
          <span className="text-[11px] text-muted">
            {mode === "ai" ? "AI calls cost time + tokens; conversion typically takes 5–15s." : "Validates against the skill schema before loading."}
          </span>
          <button
            type="button"
            onClick={convert}
            disabled={busy || !text.trim()}
            className="btn btn-primary"
          >
            {busy
              ? <><Loader2 size={14} className="animate-spin"/> Converting…</>
              : <><Wand2 size={14}/> {mode === "ai" ? "Convert with AI" : "Parse JSON"}</>}
          </button>
        </div>
      </div>
    </section>
  );
}

interface ConvertResp {
  ok?: boolean;
  mode?: "ai" | "json";
  error?: string;
  raw?: string;
  draft?: {
    key: string;
    name: string;
    category: string;
    risk_level: string;
    definition: unknown;
  };
}

// Mini-summary of the staged draft so the operator can sanity-check before
// committing it into the editor (which would overwrite any unsaved work).
function DraftPreview({ draft, onApply, onDiscard }: {
  draft: SOPDraft;
  onApply: () => void;
  onDiscard: () => void;
}) {
  let stepCount = 0;
  let summary = "";
  try {
    const def = JSON.parse(draft.definition);
    stepCount = (def.steps as unknown[])?.length ?? 0;
    summary = def.summary || "";
  } catch { /* keep zeros */ }

  return (
    <div className="border border-accent/30 bg-accent/5 rounded-md p-3 space-y-2">
      <div className="flex items-center gap-2 text-xs">
        <Sparkles size={12} className="text-accent"/>
        <span className="text-accent font-medium">Draft ready</span>
        <span className="text-muted">·</span>
        <span className="text-muted">{stepCount} step{stepCount === 1 ? "" : "s"}</span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <div><span className="text-muted">key:</span> <span className="font-mono text-text">{draft.key || "(empty — set in editor)"}</span></div>
        <div><span className="text-muted">name:</span> <span className="text-text">{draft.name}</span></div>
        <div><span className="text-muted">category:</span> <span className="text-text">{draft.category}</span></div>
        <div><span className="text-muted">risk:</span> <span className="text-text">{draft.risk_level}</span></div>
      </div>
      {summary && <div className="text-xs text-muted italic">"{summary}"</div>}
      <div className="flex items-center justify-end gap-2 pt-1">
        <button type="button" onClick={onDiscard} className="btn btn-ghost text-xs">Discard</button>
        <button type="button" onClick={onApply} className="btn btn-primary text-xs">Use this draft</button>
      </div>
    </div>
  );
}
