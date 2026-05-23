"use client";

import Link from "next/link";
import { Bell } from "lucide-react";
import type { OpsTemplateAlerts } from "@/lib/api";

// AlertsSection edits the per-template alert routing inside the
// flow editor. Off by default; once the operator enables it they
// pick channels (multi-select), optionally a body template, and
// which run states should fire. Empty channel selection saves as
// null on the wire.
export function AlertsSection({
  alerts, onChange, channels, templates,
}: {
  alerts: OpsTemplateAlerts | null;
  onChange: (next: OpsTemplateAlerts | null) => void;
  channels: { id: string; name: string; kind: string; enabled: boolean }[];
  templates: { id: string; name: string }[];
}) {
  const enabled = alerts != null;
  const empty = (): OpsTemplateAlerts => ({
    channel_ids: [],
    alert_template_id: null,
    on_start: false,
    on_success: false,
    on_failure: true,
    on_await_confirm: true,
    severity: "",
  });
  const a = alerts ?? empty();
  const set = (patch: Partial<OpsTemplateAlerts>) => onChange({ ...a, ...patch });
  const toggleChan = (id: string) => {
    const cur = new Set(a.channel_ids);
    if (cur.has(id)) cur.delete(id); else cur.add(id);
    set({ channel_ids: Array.from(cur) });
  };

  return (
    <div className="card p-3 bg-panel/40 border-border/40">
      <label className="inline-flex items-center gap-2 text-xs cursor-pointer select-none">
        <input type="checkbox" checked={enabled}
          onChange={(e) => onChange(e.target.checked ? empty() : null)}/>
        <span className="inline-flex items-center gap-1.5 font-medium">
          <Bell size={12} className="text-accent"/>
          Send alerts when this flow runs
        </span>
      </label>
      {enabled && (
        <div className="mt-3 space-y-3 pl-5">
          <div>
            <div className="text-[11px] uppercase tracking-wide text-muted/70 mb-1">Channels</div>
            {channels.length === 0 ? (
              <p className="text-[11px] text-muted">
                No channels configured. Visit <Link href="/reliability?tab=alerts" className="text-accent hover:underline">Alerts</Link> to add a WeCom / DingTalk / Feishu / webhook destination first.
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {channels.map((c) => {
                  const on = a.channel_ids.includes(c.id);
                  return (
                    <button
                      key={c.id}
                      type="button"
                      disabled={!c.enabled}
                      onClick={() => toggleChan(c.id)}
                      className={`text-[11px] px-2 py-1 rounded-full border transition-colors ${
                        on
                          ? "bg-accent/15 border-accent/50 text-accent"
                          : "border-border text-muted hover:text-text hover:border-muted/40"
                      } ${!c.enabled ? "opacity-40 cursor-not-allowed" : ""}`}
                      title={!c.enabled ? "Channel disabled" : c.kind}
                    >
                      {c.name} <span className="opacity-60">· {c.kind.replace("_robot", "")}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div>
            <div className="text-[11px] uppercase tracking-wide text-muted/70 mb-1">Fire on</div>
            <div className="flex flex-wrap gap-3 text-xs">
              {([
                ["on_start",          "Run start"],
                ["on_await_confirm",  "Awaiting approval"],
                ["on_success",        "Success"],
                ["on_failure",        "Failure"],
              ] as const).map(([key, label]) => (
                <label key={key} className="inline-flex items-center gap-1.5 cursor-pointer select-none">
                  <input type="checkbox" checked={a[key]}
                    onChange={(e) => set({ [key]: e.target.checked } as Partial<OpsTemplateAlerts>)}/>
                  <span>{label}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <div className="text-[11px] uppercase tracking-wide text-muted/70 mb-1">Body template</div>
              <select
                className="w-full bg-panel2 border border-border rounded-md px-2 py-1 text-xs"
                value={a.alert_template_id ?? ""}
                onChange={(e) => set({ alert_template_id: e.target.value || null })}
              >
                <option value="">(default — auto-formatted)</option>
                {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wide text-muted/70 mb-1">Severity override</div>
              <select
                className="w-full bg-panel2 border border-border rounded-md px-2 py-1 text-xs"
                value={a.severity ?? ""}
                onChange={(e) => set({ severity: e.target.value as OpsTemplateAlerts["severity"] })}
              >
                <option value="">(per-event default)</option>
                <option value="info">info</option>
                <option value="warning">warning</option>
                <option value="critical">critical</option>
              </select>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
