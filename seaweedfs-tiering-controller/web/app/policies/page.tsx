"use client";
import { ShieldCheck, Info, Code2, Wand2, AlertTriangle, Plus, X, Pencil } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { usePolicies, api } from "@/lib/api";
import { useEffect, useMemo, useState } from "react";
import { useT } from "@/lib/i18n";
import { Pagination, usePagination } from "@/components/pagination";
import { RefreshButton } from "@/components/refresh-button";
import { TableSkeleton } from "@/components/table-skeleton";

type FieldType = "string" | "number" | "boolean";
interface ParamField {
  key: string;
  label: string;
  zh: string;
  type: FieldType;
  default: string | number | boolean;
  hint: string;
  hintZh: string;
  placeholder?: string;
}
interface StrategyDef {
  key: string;
  title: string;
  titleZh: string;
  summary: string;
  summaryZh: string;
  fields: ParamField[];
}

const STRATEGY_DEFS: StrategyDef[] = [
  {
    key: "hot_replicate",
    title: "Hot replicate",
    titleZh: "热数据多副本",
    summary: "Keep N copies on SSD-class disks for low-latency reads.",
    summaryZh: "在 SSD 类磁盘上保留 N 份副本以满足低延迟读取。",
    fields: [
      { key: "replication", label: "Replication code", zh: "副本编码", type: "string", default: "010",
        hint: "SeaweedFS replication code, e.g. 010 = 1 copy on another rack.",
        hintZh: "SeaweedFS 副本编码，例如 010 表示在另一机架上保留 1 份副本。",
        placeholder: "010" },
      { key: "target_disk_type", label: "Target disk type", zh: "目标磁盘类型", type: "string", default: "ssd",
        hint: "Disk-type tag, e.g. ssd, nvme.",
        hintZh: "磁盘类型标签，例如 ssd、nvme。",
        placeholder: "ssd" },
    ],
  },
  {
    key: "warm_ec",
    title: "Warm EC",
    titleZh: "温数据 EC",
    summary: "Convert eligible volumes to erasure-coded shards (10+4 by default) to save space.",
    summaryZh: "将合规卷转为 EC 分片（默认 10+4）以节省空间。",
    fields: [
      { key: "data_shards", label: "Data shards", zh: "数据分片数", type: "number", default: 10,
        hint: "Number of data shards (typical: 10).",
        hintZh: "数据分片数（常用 10）。" },
      { key: "parity_shards", label: "Parity shards", zh: "校验分片数", type: "number", default: 4,
        hint: "Number of parity shards (typical: 4).",
        hintZh: "校验分片数（常用 4）。" },
      { key: "min_age_days", label: "Min age (days)", zh: "最小年龄（天）", type: "number", default: 7,
        hint: "Only EC-encode volumes older than this many days.",
        hintZh: "只对存在天数超过该阈值的卷进行 EC 编码。" },
      { key: "max_read_qps", label: "Max read QPS", zh: "读 QPS 上限", type: "number", default: 5,
        hint: "Skip volumes hotter than this QPS to avoid impacting hot traffic.",
        hintZh: "跳过 QPS 高于此阈值的卷，避免影响热流量。" },
    ],
  },
  {
    key: "cold_cloud",
    title: "Cold to cloud",
    titleZh: "冷数据上云",
    summary: "Move cold volumes to an S3-compatible bucket and free local capacity.",
    summaryZh: "将冷卷迁移到 S3 兼容存储桶并释放本地容量。",
    fields: [
      { key: "backend", label: "Backend name", zh: "后端名称", type: "string", default: "s3.default",
        hint: "Must match a configured remote.storage backend.",
        hintZh: "需匹配已配置的 remote.storage 后端名。",
        placeholder: "s3.default" },
      { key: "bucket", label: "Bucket", zh: "存储桶", type: "string", default: "",
        hint: "Target S3 bucket name.",
        hintZh: "目标 S3 存储桶名称。",
        placeholder: "seaweed-cold-archive" },
      { key: "min_age_days", label: "Min age (days)", zh: "最小年龄（天）", type: "number", default: 30,
        hint: "Only upload volumes older than this many days.",
        hintZh: "只上传存在天数超过该阈值的卷。" },
      { key: "keep_local_copy", label: "Keep local copy", zh: "保留本地副本", type: "boolean", default: false,
        hint: "If true, keep the local volume after upload (slower reclaim).",
        hintZh: "为 true 时上传后保留本地卷（回收较慢）。" },
    ],
  },
  {
    key: "archive",
    title: "Archive",
    titleZh: "归档",
    summary: "Mark volumes as cold-archive, freezing further writes.",
    summaryZh: "将卷标记为冷归档，冻结后续写入。",
    fields: [
      { key: "tier", label: "Archive tier", zh: "归档层级", type: "string", default: "glacier",
        hint: "Logical archive tier label (informational).",
        hintZh: "逻辑归档层级标签（仅信息）。",
        placeholder: "glacier" },
      { key: "min_idle_days", label: "Min idle (days)", zh: "最小空闲（天）", type: "number", default: 90,
        hint: "Volumes idle longer than this become archive candidates.",
        hintZh: "空闲天数超过该阈值的卷会成为归档候选。" },
    ],
  },
];

const SCOPES = ["global", "collection", "bucket", "regex"] as const;
const SCOPE_HINT_EN: Record<string, string> = {
  global:     "Applies to every volume on every cluster.",
  collection: 'Collection name, e.g. "images" — use * for all collections.',
  bucket:     "S3 bucket name (when SeaweedFS S3 gateway is in use).",
  regex:      "Go regex matched against the volume's collection name.",
};
const SCOPE_HINT_ZH: Record<string, string> = {
  global:     "作用于所有集群上的所有卷。",
  collection: "集合名，例如 images；使用 * 表示所有集合。",
  bucket:     "S3 存储桶名（启用 SeaweedFS S3 网关时使用）。",
  regex:      "Go 正则，匹配卷的 collection 名。",
};

function defaultParamsFor(strategy: string): Record<string, unknown> {
  const def = STRATEGY_DEFS.find(s => s.key === strategy);
  if (!def) return {};
  return Object.fromEntries(def.fields.map(f => [f.key, f.default]));
}

type PolicyRow = {
  id: string;
  name: string;
  scope_kind: string;
  scope_value: string;
  strategy: string;
  params?: Record<string, unknown>;
  sample_rate: number;
  dry_run: boolean;
  enabled: boolean;
};

export default function PoliciesPage() {
  const { t, lang } = useT();
  const { data, mutate, isLoading, isValidating } = usePolicies();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<PolicyRow | null>(null);

  function openCreate() {
    setEditing(null);
    setOpen(true);
  }
  function openEdit(p: PolicyRow) {
    setEditing(p);
    setOpen(true);
  }

  const items: PolicyRow[] = data?.items || [];
  const pg = usePagination(items, 20);

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-base font-semibold tracking-tight">{t("Policies")}</h1>
          <p className="text-sm text-muted mt-1">
            {t("A policy answers: which volumes, by what rule, get moved to which tier.")}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <RefreshButton loading={isValidating} onClick={() => mutate()}/>
          <button className="btn btn-primary flex items-center gap-1.5" onClick={openCreate}>
            <Plus size={14}/> {t("New policy")}
          </button>
        </div>
      </header>

      <section className="card p-5">
        {isLoading && !data ? (
          <TableSkeleton rows={5} headers={[t("Name"), t("Scope"), t("Strategy"), t("Sample"), t("Dry-run"), t("Enabled"), ""]}/>
        ) : items.length ? (
          <table className="grid">
            <thead><tr>
              <th>{t("Name")}</th>
              <th>{t("Scope")}</th>
              <th>{t("Strategy")}</th>
              <th>{t("Sample")}</th>
              <th>{t("Dry-run")}</th>
              <th>{t("Enabled")}</th>
              <th></th>
            </tr></thead>
            <tbody>
              {pg.slice.map(p => (
                <tr key={p.id}>
                  <td className="font-medium">{p.name}</td>
                  <td><span className="badge">{t(p.scope_kind)}</span> {p.scope_value}</td>
                  <td><span className="badge">{t(p.strategy)}</span></td>
                  <td>{p.sample_rate}</td>
                  <td>{p.dry_run ? t("yes") : t("no")}</td>
                  <td>{p.enabled ? t("yes") : t("no")}</td>
                  <td>
                    <button
                      className="text-xs text-muted hover:text-accent flex items-center gap-1"
                      onClick={() => openEdit(p)}
                      title={t("Edit")}
                    >
                      <Pencil size={12}/> {t("Edit")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        {items.length > 0 && <Pagination {...pg}/>}
        {items.length === 0 && (
          <EmptyState
            icon={ShieldCheck}
            title={t("No migration policies")}
            hint={t("Policies decide which volumes get warm-ed or cold-ed.")}
            action={
              <button className="btn btn-primary flex items-center gap-1.5" onClick={openCreate}>
                <Plus size={14}/> {t("New policy")}
              </button>
            }
          />
        )}
      </section>

      {open && (
        <PolicyDialog
          initial={editing}
          onClose={() => setOpen(false)}
          onSaved={async () => {
            await mutate();
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}

function PolicyDialog({ initial, onClose, onSaved }: {
  initial: PolicyRow | null;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}) {
  const { t, lang } = useT();
  const isEdit = !!initial;

  const [strategy, setStrategy] = useState<string>(initial?.strategy ?? "warm_ec");
  const [params, setParams] = useState<Record<string, unknown>>(
    () => initial?.params ?? defaultParamsFor(initial?.strategy ?? "warm_ec"),
  );
  const [draft, setDraft] = useState({
    name: initial?.name ?? "",
    scope_kind: initial?.scope_kind ?? "collection",
    scope_value: initial?.scope_value ?? "*",
    sample_rate: initial?.sample_rate ?? 1.0,
    dry_run: initial?.dry_run ?? true,
    enabled: initial?.enabled ?? true,
  });
  const [advanced, setAdvanced] = useState(false);
  const [rawJson, setRawJson] = useState<string>(
    JSON.stringify(initial?.params ?? defaultParamsFor(initial?.strategy ?? "warm_ec"), null, 2),
  );
  const [jsonErr, setJsonErr] = useState<string>("");
  const [saving, setSaving] = useState(false);

  const strategyDef = useMemo(
    () => STRATEGY_DEFS.find(s => s.key === strategy) ?? STRATEGY_DEFS[0],
    [strategy],
  );
  const scopeHint = (lang === "zh" ? SCOPE_HINT_ZH : SCOPE_HINT_EN)[draft.scope_kind] ?? "";

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function applyStrategy(next: string) {
    setStrategy(next);
    const fresh = defaultParamsFor(next);
    setParams(fresh);
    setRawJson(JSON.stringify(fresh, null, 2));
    setJsonErr("");
  }

  function setParam(k: string, v: unknown) {
    const merged = { ...params, [k]: v };
    setParams(merged);
    setRawJson(JSON.stringify(merged, null, 2));
  }

  function onRawJsonChange(v: string) {
    setRawJson(v);
    try {
      const parsed = JSON.parse(v || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        setParams(parsed as Record<string, unknown>);
        setJsonErr("");
      } else {
        setJsonErr(t("Params must be a JSON object."));
      }
    } catch (e: unknown) {
      setJsonErr(e instanceof Error ? e.message : "Invalid JSON");
    }
  }

  async function save() {
    if (jsonErr || !draft.name.trim()) return;
    setSaving(true);
    try {
      await api.upsertPolicy({ ...draft, strategy, params });
      await onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 backdrop-blur-sm p-4 md:p-8"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="card w-full max-w-3xl my-auto shadow-2xl">
        <header className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div>
            <h2 className="text-base font-semibold">
              {isEdit ? t("Edit policy") : t("New policy")}
            </h2>
            <p className="text-xs text-muted mt-0.5">
              {t("A policy answers: which volumes, by what rule, get moved to which tier.")}
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-md hover:bg-panel2 text-muted hover:text-text" title={t("Close")}>
            <X size={16}/>
          </button>
        </header>

        <div className="px-5 py-5 space-y-5 max-h-[70vh] overflow-y-auto">
          {/* Identity */}
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("Name")} hint={t("A short identifier, e.g. archive-cold-logs.")}>
              <input className="input w-full" value={draft.name}
                placeholder="archive-cold-logs"
                onChange={e => setDraft({ ...draft, name: e.target.value })} />
            </Field>
            <Field label={t("Strategy")} hint={lang === "zh" ? strategyDef.summaryZh : strategyDef.summary}>
              <select className="input w-full" value={strategy}
                onChange={e => applyStrategy(e.target.value)}>
                {STRATEGY_DEFS.map(s => <option key={s.key} value={s.key}>{lang === "zh" ? s.titleZh : s.title}</option>)}
              </select>
            </Field>
            <Field label={t("Scope kind")} hint={scopeHint}>
              <select className="input w-full" value={draft.scope_kind}
                onChange={e => setDraft({ ...draft, scope_kind: e.target.value })}>
                {SCOPES.map(s => <option key={s} value={s}>{t(s)}</option>)}
              </select>
            </Field>
            <Field label={t("Scope value")} hint={t("Pattern matched against the scope kind. Use * to match everything.")}>
              <input className="input w-full" value={draft.scope_value}
                placeholder="*"
                onChange={e => setDraft({ ...draft, scope_value: e.target.value })} />
            </Field>
            <Field label={t("Sample rate")} hint={t("0–1 fraction of matching volumes to enqueue per run (1 = all).")}>
              <input className="input w-full" type="number" step="0.1" min={0} max={1}
                value={draft.sample_rate}
                onChange={e => setDraft({ ...draft, sample_rate: Number(e.target.value) })}/>
            </Field>
            <div className="flex items-end gap-6">
              <Toggle label={t("Dry run")} hint={t("Plan only, no real moves.")}
                checked={draft.dry_run}
                onChange={v => setDraft({ ...draft, dry_run: v })} />
              <Toggle label={t("Enabled")} hint={t("Inactive policies are skipped by the scorer.")}
                checked={draft.enabled}
                onChange={v => setDraft({ ...draft, enabled: v })} />
            </div>
          </div>

          {/* Strategy parameters */}
          <div className="border-t border-border pt-5">
            <div className="flex items-center justify-between mb-3">
              <div className="min-w-0">
                <h3 className="text-sm font-medium flex items-center gap-2">
                  <Wand2 size={14} className="text-accent"/>
                  {t("Strategy parameters")}
                  <span className="text-muted font-normal">· {lang === "zh" ? strategyDef.titleZh : strategyDef.title}</span>
                </h3>
                <p className="text-xs text-muted mt-1 flex items-center gap-1.5">
                  <Info size={12}/>
                  {lang === "zh" ? strategyDef.summaryZh : strategyDef.summary}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setAdvanced(v => !v)}
                className="text-xs px-2 py-1 rounded-md border border-border text-muted hover:text-text flex items-center gap-1 shrink-0"
              >
                <Code2 size={12}/> {advanced ? t("Form view") : t("Edit JSON")}
              </button>
            </div>

            {!advanced ? (
              <div className="grid grid-cols-2 gap-3">
                {strategyDef.fields.map(f => (
                  <ParamInput key={f.key} field={f} value={params[f.key]}
                    onChange={v => setParam(f.key, v)} lang={lang}/>
                ))}
              </div>
            ) : (
              <div className="space-y-2">
                <textarea
                  className="input w-full font-mono text-xs h-40"
                  value={rawJson}
                  onChange={e => onRawJsonChange(e.target.value)}
                  spellCheck={false}
                />
                {jsonErr ? (
                  <div className="text-xs text-danger flex items-center gap-1">
                    <AlertTriangle size={12}/> {jsonErr}
                  </div>
                ) : (
                  <div className="text-xs text-muted">
                    {t("Edit values directly. Switch back to Form view for guided fields.")}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <footer className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border bg-panel2/30">
          <button className="btn" onClick={onClose}>{t("Cancel")}</button>
          <button
            className="btn btn-primary"
            disabled={!!jsonErr || !draft.name.trim() || saving}
            onClick={save}
          >
            {saving ? t("Saving…") : isEdit ? t("Save changes") : t("Create policy")}
          </button>
        </footer>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-text">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-muted leading-relaxed">{hint}</span>}
    </label>
  );
}

function Toggle({ label, hint, checked, onChange }: {
  label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex flex-col gap-1 select-none">
      <span className="flex items-center gap-2 text-xs font-medium text-text">
        <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)}/>
        {label}
      </span>
      {hint && <span className="text-[11px] text-muted leading-relaxed">{hint}</span>}
    </label>
  );
}

function ParamInput({ field, value, onChange, lang }: {
  field: ParamField; value: unknown; onChange: (v: unknown) => void; lang: string;
}) {
  const label = lang === "zh" ? field.zh : field.label;
  const hint = lang === "zh" ? field.hintZh : field.hint;

  if (field.type === "boolean") {
    return <Toggle label={label} hint={hint} checked={!!value} onChange={onChange}/>;
  }
  if (field.type === "number") {
    return (
      <Field label={label} hint={hint}>
        <input className="input w-full" type="number"
          value={value as number ?? ""}
          onChange={e => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
          placeholder={field.placeholder}/>
      </Field>
    );
  }
  return (
    <Field label={label} hint={hint}>
      <input className="input w-full"
        value={(value as string) ?? ""}
        onChange={e => onChange(e.target.value)}
        placeholder={field.placeholder}/>
    </Field>
  );
}
