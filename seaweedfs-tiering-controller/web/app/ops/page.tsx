"use client";

import { useMemo, useState } from "react";
import {
  Terminal, Search, AlertTriangle, ShieldAlert, Eye, Loader2, Play, Activity,
  ChevronRight, RefreshCw,
} from "lucide-react";
import { useClusters, useShellCatalog, useClusterHealth, api, getToken, type ShellCommand } from "@/lib/api";
import { useT } from "@/lib/i18n";

// ----------------------- types & helpers -----------------------

type Risk = "read" | "mutate" | "destructive";

// Category metadata: order in the UI sidebar + English label.
// Risk → tailwind classes for the badge.
const CATEGORIES: { key: string; label: string }[] = [
  { key: "volume",     label: "Volume" },
  { key: "tier",       label: "Tiering" },
  { key: "ec",         label: "Erasure Coding" },
  { key: "collection", label: "Collection" },
  { key: "fs",         label: "Filer FS" },
  { key: "s3-bucket",  label: "S3 Bucket" },
  { key: "s3-iam",     label: "S3 IAM" },
  { key: "s3-tables",  label: "S3 Tables" },
  { key: "remote",     label: "Remote Tier" },
  { key: "cluster",    label: "Cluster" },
  { key: "mq",         label: "Message Queue" },
  { key: "mount",      label: "Mount" },
  { key: "system",     label: "System" },
];

const RISK_BADGE: Record<Risk, string> = {
  read:        "badge border-emerald-400/40 text-emerald-300",
  mutate:      "badge border-amber-400/40 text-amber-300",
  destructive: "badge border-rose-400/40 text-rose-300",
};

const RISK_ICON: Record<Risk, JSX.Element> = {
  read:        <Eye size={12} />,
  mutate:      <AlertTriangle size={12} />,
  destructive: <ShieldAlert size={12} />,
};

// buildArgString folds the typed form values back into a single
// "-flag value -bool -flag2 value2" string that `weed shell` expects.
// Positional args (Flag === "") are appended without a leading flag.
// Unset / empty values are skipped so the operator can leave optional
// flags blank and not have weed reject `-collection ""`.
function buildArgString(
  argsSpec: ShellCommand["args"],
  values: Record<string, string | boolean>,
  rawExtra: string,
): string {
  const parts: string[] = [];
  for (const a of argsSpec || []) {
    const v = values[a.flag];
    if (a.kind === "bool") {
      if (v === true) parts.push(a.flag);
      continue;
    }
    if (typeof v !== "string" || v.trim() === "") continue;
    if (a.flag === "") {
      parts.push(v.trim());
    } else {
      // weed shell accepts "-flag=value" or "-flag value"; the equals form
      // is unambiguous when the value contains hyphens (e.g. "-replication 010").
      parts.push(`${a.flag}=${v.trim()}`);
    }
  }
  if (rawExtra.trim()) parts.push(rawExtra.trim());
  return parts.join(" ");
}

// ----------------------- page -----------------------

export default function OpsPage() {
  const { t } = useT();
  const { data: clustersData } = useClusters();
  const { data: catalogData, isLoading: catalogLoading } = useShellCatalog();

  const clusters = clustersData?.items || [];
  const enabledClusters = clusters.filter((c: { enabled: boolean }) => c.enabled);

  const [clusterID, setClusterID] = useState<string>("");
  // Auto-select first enabled cluster once they load.
  if (!clusterID && enabledClusters.length > 0) {
    setTimeout(() => setClusterID(enabledClusters[0].id), 0);
  }

  const [category, setCategory] = useState<string>("volume");
  const [search, setSearch]     = useState("");
  const [selected, setSelected] = useState<ShellCommand | null>(null);

  const allCommands = catalogData?.items || [];
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allCommands.filter((c) => {
      if (c.category !== category) return false;
      if (!q) return true;
      return c.name.toLowerCase().includes(q) || c.summary.toLowerCase().includes(q);
    });
  }, [allCommands, category, search]);

  const countByCategory = useMemo(() => {
    const m: Record<string, number> = {};
    for (const c of allCommands) m[c.category] = (m[c.category] || 0) + 1;
    return m;
  }, [allCommands]);

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <Terminal size={20}/> {t("Ops Console")}
          </h1>
          <p className="text-sm text-muted">{t("Run any weed shell command against a cluster with guided forms and audit.")}</p>
        </div>
        <ClusterPicker
          clusters={enabledClusters}
          value={clusterID}
          onChange={setClusterID}
        />
      </header>

      <div className="grid grid-cols-12 gap-4">
        {/* category rail */}
        <aside className="col-span-3 card p-3 space-y-1">
          <div className="flex items-center gap-2 px-2 py-1 rounded-md bg-panel2 mb-2">
            <Search size={14} className="text-muted"/>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("Search commands…")}
              className="bg-transparent text-sm outline-none flex-1"
            />
          </div>
          {CATEGORIES.map((c) => (
            <button
              key={c.key}
              onClick={() => { setCategory(c.key); setSelected(null); }}
              className={
                "w-full flex items-center justify-between rounded-md px-3 py-1.5 text-sm transition-colors " +
                (category === c.key ? "bg-accent/15 text-accent" : "text-muted hover:bg-panel2 hover:text-text")
              }
            >
              <span>{t(c.label)}</span>
              <span className="text-[11px] text-muted">{countByCategory[c.key] ?? 0}</span>
            </button>
          ))}
        </aside>

        {/* command list */}
        <section className="col-span-4 card p-3 space-y-1 max-h-[75vh] overflow-y-auto">
          {catalogLoading && <div className="text-sm text-muted px-3 py-6">{t("Loading…")}</div>}
          {!catalogLoading && visible.length === 0 && (
            <div className="text-sm text-muted px-3 py-6">{t("No commands match your search.")}</div>
          )}
          {visible.map((c) => (
            <button
              key={c.name}
              onClick={() => setSelected(c)}
              className={
                "w-full text-left rounded-md px-3 py-2 transition-colors " +
                (selected?.name === c.name ? "bg-accent/15 ring-1 ring-accent/40" : "hover:bg-panel2")
              }
            >
              <div className="flex items-center justify-between">
                <span className="font-mono text-sm">{c.name}</span>
                <span className={RISK_BADGE[c.risk]}>
                  <span className="inline-flex items-center gap-1">{RISK_ICON[c.risk]} {t(c.risk)}</span>
                </span>
              </div>
              <div className="text-xs text-muted mt-1 line-clamp-2">{c.summary}</div>
            </button>
          ))}
        </section>

        {/* run panel */}
        <section className="col-span-5">
          {selected
            ? <RunPanel cluster={clusterID} cmd={selected} />
            : <EmptyRunPanel/>}
        </section>
      </div>
    </div>
  );
}

// ----------------------- cluster picker w/ health -----------------------

function ClusterPicker({
  clusters, value, onChange,
}: { clusters: Array<{ id: string; name: string; master_addr: string }>; value: string; onChange: (id: string) => void; }) {
  const { t } = useT();
  return (
    <div className="flex items-center gap-3">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-panel2 border border-border rounded-md px-3 py-1.5 text-sm"
      >
        <option value="">{t("Select cluster…")}</option>
        {clusters.map((c) => (
          <option key={c.id} value={c.id}>{c.name} — {c.master_addr}</option>
        ))}
      </select>
      {value && <HealthBadge clusterID={value} />}
    </div>
  );
}

function HealthBadge({ clusterID }: { clusterID: string }) {
  const { t } = useT();
  const { data, isLoading, mutate } = useClusterHealth(clusterID);
  if (isLoading) {
    return <span className="badge text-muted"><Loader2 size={12} className="animate-spin"/> {t("probing…")}</span>;
  }
  if (!data) return null;
  const color = data.reachable
    ? "border-emerald-400/40 text-emerald-300"
    : "border-rose-400/40 text-rose-300";
  return (
    <button
      onClick={() => mutate()}
      title={data.error || `${data.latency_ms}ms`}
      className={`badge ${color} inline-flex items-center gap-1.5`}
    >
      <Activity size={12}/>
      {data.reachable ? `${data.latency_ms}ms` : t("unreachable")}
      <RefreshCw size={10} className="opacity-50"/>
    </button>
  );
}

// ----------------------- run panel -----------------------

function EmptyRunPanel() {
  const { t } = useT();
  return (
    <div className="card p-8 text-center text-sm text-muted">
      <Terminal size={32} className="mx-auto mb-2 text-muted/50"/>
      {t("Pick a command on the left to see its arguments and run it.")}
    </div>
  );
}

function RunPanel({ cluster, cmd }: { cluster: string; cmd: ShellCommand }) {
  const { t } = useT();
  const [values, setValues]   = useState<Record<string, string | boolean>>(() => initValues(cmd));
  const [rawExtra, setRaw]    = useState("");
  const [reason, setReason]   = useState("");
  const [running, setRunning] = useState(false);
  const [output, setOutput]   = useState<string>("");
  const [error, setError]     = useState<string>("");

  // Re-initialise field state when the selected command changes.
  // useMemo + setState would loop; we key off the command name.
  const [boundTo, setBoundTo] = useState<string>(cmd.name);
  if (boundTo !== cmd.name) {
    setBoundTo(cmd.name);
    setValues(initValues(cmd));
    setRaw("");
    setReason("");
    setOutput("");
    setError("");
  }

  const needsReason = cmd.risk !== "read";
  const canRun = !!cluster && !running && (!needsReason || reason.trim().length > 0);

  async function run() {
    setRunning(true);
    setError("");
    setOutput("");
    const args = buildArgString(cmd.args, values, rawExtra);
    if (cmd.streams) {
      // Long-running commands: stream stdout via SSE so the operator sees
      // each progress line live instead of waiting for the buffered POST.
      try {
        await streamShell(cluster, cmd.name, args, reason, (ln) => setOutput((s) => s + ln + "\n"));
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setRunning(false);
      }
      return;
    }
    try {
      const r = await api.runClusterShell(cluster, { command: cmd.name, args, reason });
      setOutput(r.output || "");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="card p-4 space-y-4 max-h-[75vh] overflow-y-auto">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-mono text-base">{cmd.name}</div>
          <p className="text-xs text-muted mt-1">{cmd.summary}</p>
        </div>
        <span className={RISK_BADGE[cmd.risk]}>
          <span className="inline-flex items-center gap-1">{RISK_ICON[cmd.risk]} {t(cmd.risk)}</span>
        </span>
      </div>

      {cmd.args && cmd.args.length > 0 && (
        <div className="space-y-3">
          <div className="text-xs uppercase tracking-wider text-muted/70">{t("Arguments")}</div>
          {cmd.args.map((a) => (
            <ArgField
              key={a.flag || a.label}
              spec={a}
              value={values[a.flag]}
              onChange={(v) => setValues((s) => ({ ...s, [a.flag]: v }))}
            />
          ))}
        </div>
      )}

      <div className="space-y-1">
        <label className="text-xs text-muted">{t("Raw extra args (advanced)")}</label>
        <input
          value={rawExtra}
          onChange={(e) => setRaw(e.target.value)}
          placeholder='-some-flag=value …'
          className="w-full bg-panel2 border border-border rounded-md px-3 py-1.5 text-sm font-mono"
        />
      </div>

      {needsReason && (
        <div className="space-y-1">
          <label className="text-xs text-muted">
            {t("Reason")} <span className="text-rose-400">*</span>
          </label>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t("Why are you running this? (logged in audit)")}
            className="w-full bg-panel2 border border-border rounded-md px-3 py-1.5 text-sm"
          />
        </div>
      )}

      <div className="flex items-center justify-between pt-1">
        <div className="text-[11px] text-muted font-mono truncate flex-1 mr-3">
          $ weed shell : {cmd.name}{(() => {
            const s = buildArgString(cmd.args, values, rawExtra);
            return s ? ` ${s}` : "";
          })()}
        </div>
        <button
          onClick={run}
          disabled={!canRun}
          className="btn bg-accent text-accent-fg hover:bg-accent/90 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-2"
        >
          {running ? <Loader2 size={14} className="animate-spin"/> : <Play size={14}/>}
          {t("Run")}
        </button>
      </div>

      {!cluster && (
        <div className="text-xs text-amber-300 bg-amber-400/10 border border-amber-400/30 rounded-md px-3 py-2">
          {t("Pick a cluster first.")}
        </div>
      )}

      {error && (
        <div className="text-xs font-mono text-rose-300 bg-rose-400/10 border border-rose-400/30 rounded-md px-3 py-2 whitespace-pre-wrap break-all">
          {error}
        </div>
      )}

      {output && (
        <div className="space-y-1">
          <div className="text-xs uppercase tracking-wider text-muted/70 flex items-center gap-2">
            <ChevronRight size={12}/> {t("Output")}
          </div>
          <pre className="text-[11px] font-mono bg-black/40 border border-border rounded-md p-3 max-h-96 overflow-auto whitespace-pre-wrap break-all">
            {output}
          </pre>
        </div>
      )}
    </div>
  );
}

// streamShell opens an SSE stream against /clusters/:id/shell/stream and
// dispatches each "line" event to onLine. EventSource can't attach an
// Authorization header, so we use fetch + manual SSE parsing instead.
// Resolves on event "done", rejects on event "error" with the server's
// message — matches the same backend contract as runClusterShell.
async function streamShell(
  clusterID: string,
  command: string,
  args: string,
  reason: string,
  onLine: (line: string) => void,
): Promise<void> {
  const qs = new URLSearchParams({ command });
  if (args)   qs.set("args", args);
  if (reason) qs.set("reason", reason);
  const url = `/api/v1/clusters/${clusterID}/shell/stream?${qs.toString()}`;
  const headers: Record<string, string> = {};
  const tok = getToken();
  if (tok) headers["Authorization"] = `Bearer ${tok}`;
  const r = await fetch(url, { headers });
  if (!r.ok || !r.body) throw new Error(`${r.status} ${await r.text()}`);
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let event = "line";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const raw of lines) {
      if (raw.startsWith("event: ")) {
        event = raw.slice(7).trim();
      } else if (raw.startsWith("data: ")) {
        const payload = raw.slice(6);
        if (event === "line") onLine(payload);
        else if (event === "error") throw new Error(payload);
        else if (event === "done") return;
      }
    }
  }
}

function initValues(cmd: ShellCommand): Record<string, string | boolean> {
  const v: Record<string, string | boolean> = {};
  for (const a of cmd.args || []) {
    if (a.kind === "bool") v[a.flag] = a.default === "true";
    else v[a.flag] = a.default ?? "";
  }
  return v;
}

// ----------------------- arg field -----------------------

function ArgField({
  spec, value, onChange,
}: {
  spec: NonNullable<ShellCommand["args"]>[number];
  value: string | boolean | undefined;
  onChange: (v: string | boolean) => void;
}) {
  const labelEl = (
    <label className="text-xs text-muted flex items-center gap-2">
      <span>{spec.label}{spec.required && <span className="text-rose-400 ml-1">*</span>}</span>
      {spec.flag && <code className="text-[10px] text-muted/60">{spec.flag}</code>}
    </label>
  );

  if (spec.kind === "bool") {
    return (
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
          className="rounded border-border"
        />
        <span className="text-sm">{spec.label}</span>
        {spec.flag && <code className="text-[10px] text-muted/60">{spec.flag}</code>}
        {spec.help && <span className="text-[11px] text-muted">— {spec.help}</span>}
      </label>
    );
  }

  if (spec.kind === "enum") {
    return (
      <div className="space-y-1">
        {labelEl}
        <select
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          className="w-full bg-panel2 border border-border rounded-md px-3 py-1.5 text-sm"
        >
          <option value="">—</option>
          {spec.enum?.map((opt) => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
        {spec.help && <p className="text-[11px] text-muted">{spec.help}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {labelEl}
      <input
        type={spec.kind === "int" ? "number" : "text"}
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder={spec.default || ""}
        className="w-full bg-panel2 border border-border rounded-md px-3 py-1.5 text-sm font-mono"
      />
      {spec.help && <p className="text-[11px] text-muted">{spec.help}</p>}
    </div>
  );
}
