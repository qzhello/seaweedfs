"use client";

import { useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { api, type OpsTemplate } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { ModalShell } from "./modal-shell";

// AIDraftDialog asks the AI to propose a template envelope from a
// free-text description. Example prompts seed the textarea so the
// operator isn't staring at a blank box. On success the drafted
// template is handed to the editor for review before saving.
export function AIDraftDialog({
  onCancel, onAccept,
}: {
  onCancel: () => void;
  onAccept: (draft: OpsTemplate) => void;
}) {
  const { t, lang } = useT();
  const [text, setText]       = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState("");
  const [raw, setRaw]         = useState("");

  async function draft() {
    setError(""); setRaw(""); setLoading(true);
    try {
      const r = await api.draftOpsTemplate(text, lang);
      if (!r.ok) {
        setError(r.error || t("AI returned no usable draft."));
        if (r.raw) setRaw(r.raw);
        return;
      }
      const d = r.draft as unknown as OpsTemplate;
      onAccept({
        id: "",
        name: d.name,
        description: d.description,
        category: d.category,
        steps: Array.isArray(d.steps) ? d.steps : [],
      });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  const examples = [
    t("Create an S3 bucket called acme-logs for tenant Acme, give it a 50GB quota, enable versioning, then create a service account scoped to it."),
    t("Identify the volume server with the most volumes, move one volume from it to the server with the fewest volumes, then rebalance the cluster."),
    t("Encode all volumes in collection 'cold-logs' to EC, then balance shards across racks."),
  ];

  return (
    <ModalShell onClose={onCancel} title={t("Draft a template with AI")}>
      <div className="space-y-3">
        <p className="text-xs text-muted">
          {t("Describe what you want the playbook to do, in your own words. The AI will pick commands from the catalog and propose a draft you can review and edit before saving.")}
        </p>
        <div className="flex flex-wrap gap-1.5">
          <span className="text-[11px] text-muted self-center">{t("Try:")}</span>
          {examples.map((ex, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setText(ex)}
              className="text-[11px] px-2 py-1 rounded-md border border-border bg-panel2 hover:bg-panel2/70 hover:border-accent/40 text-left truncate max-w-[18rem]"
              title={ex}
            >
              {ex}
            </button>
          ))}
        </div>
        <textarea
          value={text} onChange={(e) => setText(e.target.value)} rows={6}
          placeholder={t("e.g. Create an S3 bucket called acme-logs for tenant Acme, give it a 50GB quota, enable versioning, then create a service account scoped to it.")}
          className="w-full bg-panel2 border border-border rounded-md px-3 py-2 text-sm"
        />
        {error && (
          <div className="text-xs text-danger bg-danger/10 border border-danger/30 rounded-md px-3 py-2 space-y-2">
            <div>{error}</div>
            {raw && (
              <details>
                <summary className="cursor-pointer text-muted">{t("Show raw AI response")}</summary>
                <pre className="mt-2 text-[11px] font-mono whitespace-pre-wrap break-all">{raw}</pre>
              </details>
            )}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="btn">{t("Cancel")}</button>
          <button onClick={draft} disabled={loading || !text.trim()}
            className="btn bg-accent text-accent-fg inline-flex items-center gap-2">
            {loading ? <Loader2 size={14} className="animate-spin"/> : <Sparkles size={14}/>}
            {t("Draft")}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
