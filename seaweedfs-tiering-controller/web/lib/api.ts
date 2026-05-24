import useSWR from "swr";

export const BASE = "/api/v1";

// ---------------- token storage ----------------

const TOKEN_KEY = "tier.token";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(t: string | null) {
  if (typeof window === "undefined") return;
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}

// langHeader reads the operator's current locale from localStorage (set
// by the i18n module's `tier.lang` key) so every API call automatically
// carries the language preference. Backend handlers that build prompts
// for the AI provider read this header to tell the model which
// language to write user-facing fields in. Default "zh" matches the
// i18n module's initial state.
function currentLang(): string {
  if (typeof window === "undefined") return "zh";
  try {
    const v = localStorage.getItem("tier.lang");
    if (v === "en" || v === "zh") return v;
  } catch { /* ignore */ }
  return "zh";
}

export function authHeaders(): Record<string, string> {
  const t = getToken();
  const h: Record<string, string> = { "X-Tier-Lang": currentLang() };
  if (t) h["Authorization"] = `Bearer ${t}`;
  return h;
}

// ---------------- fetchers ----------------

const fetcher = async (url: string) => {
  const r = await fetch(url, { headers: authHeaders() });
  if (r.status === 401) {
    if (typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
      window.location.href = "/login";
    }
    throw new Error("unauthorized");
  }
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
};

async function jpost(url: string, body?: unknown, method: "POST" | "PUT" | "DELETE" = "POST") {
  const r = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  if (r.status === 204) return null;
  return r.json();
}

// ---------------- hooks ----------------

// Refresh policy: background polling is OFF for everything except live
// execution surfaces (task autonomy waterfall, exec stream). Every list
// page has an explicit Refresh button that calls `mutate()` so the
// operator gets fresh data on demand instead of paying gRPC roundtrips
// the moment the page is open. The SWRConfig in components/shell.tsx
// keeps previously fetched data on screen so navigation stays instant.
export interface Volume {
  ID: number;
  Collection?: string;
  Size: number;
  FileCount: number;
  ReadOnly?: boolean;
  DiskType?: string;
  Server: string;
  Rack?: string;
  DataCenter?: string;
  ModifiedAtSec?: number;
  cluster_id?: string;
  cluster_name?: string;
}

export function useSummary()       { return useSWR(`${BASE}/dashboard/summary`, fetcher); }
export function useVolumes(clusterID?: string) {
  const url = clusterID ? `${BASE}/volumes?cluster_id=${encodeURIComponent(clusterID)}` : `${BASE}/volumes`;
  return useSWR(url, fetcher);
}
export function useHeatmap(h = 168){ return useSWR(`${BASE}/volumes/heatmap?hours=${h}`, fetcher); }

// ---- Volume feature trend (sparklines) ----
export interface VolumeFeatureDailyPoint {
  day: string;        // ISO date — one downsampled day of history
  size_bytes: number;
  reads_7d: number;
}
// Bulk per-volume feature history for the volumes-list sparklines. `ids`
// is the visible page's volume IDs; the SWR key is the sorted id list so
// paging refetches while identical pages stay cached.
export function useVolumeTrendBulk(ids: number[], days = 30) {
  const key = ids.length ? [...ids].sort((a, b) => a - b).join(",") : "";
  return useSWR<{ items: Record<string, VolumeFeatureDailyPoint[]>; days: number }>(
    key ? `${BASE}/volumes/features/trend/bulk?ids=${key}&days=${days}` : null,
    fetcher,
  );
}

// ---- Temperature dashboard ----
export type TempBand = "hot" | "warm" | "cool" | "cold" | "frozen";
export interface CollectionTemperature {
  collection: string;
  volumes: number;
  total_size: number;
  reads_7d: number;
  reads_30d: number;
  hot_n: number;    hot_size: number;
  warm_n: number;   warm_size: number;
  cool_n: number;   cool_size: number;
  cold_n: number;   cold_size: number;
  frozen_n: number; frozen_size: number;
}
export interface VolumeTemperature {
  volume_id: number;
  collection: string;
  band: TempBand;
  size_bytes: number;
  reads_7d: number;
  reads_30d: number;
  quiet_for_seconds: number;
  is_readonly: boolean;
}
export interface TempThresholds {
  hot_reads_7d: number;
  hot_quiet_seconds: number;
  frozen_seconds: number;
}
export function useCollectionTemperatures() {
  return useSWR<{
    items: CollectionTemperature[];
    total: Omit<CollectionTemperature, "collection">;
    thresholds: TempThresholds;
  }>(`${BASE}/temperature/collections`, fetcher);
}
// ---- Costs / pricing / AI plan ----
export interface BackendPricing {
  id: string;
  name: string;
  display_name: string;
  kind: "hot" | "warm" | "cold" | "archive";
  currency: string;
  storage_price_per_tb_month: number;
  egress_price_per_tb: number;
  request_price_per_million: number;
  min_billable_bytes: number;
  replication_factor: number;
  is_hot_reference: boolean;
  notes: string;
  created_at: string;
  updated_at: string;
}
export interface BackendBucket {
  name: string;
  display_name: string;
  kind: string;
  currency: string;
  physical_bytes: number;
  logical_bytes: number;
  volume_count: number;
  price_per_tb_month: number;
  monthly_cost: number;
  counterfactual_cost: number;
  has_pricing: boolean;
}
export interface CollectionCostRow {
  collection: string;
  physical_bytes: number;
  monthly_cost: number;
  by_backend_bytes: Record<string, number>;
  by_backend_cost: Record<string, number>;
}
export interface CostRecommendation {
  kind: string;
  collection?: string;
  volume_id?: number;
  from_backend: string;
  to_backend: string;
  bytes: number;
  monthly_saving: number;
  currency: string;
  rationale: string;
}
export interface CostsResponse {
  cluster_id: string;
  generated_at: string;
  currency: string;
  total_monthly_cost: number;
  counterfactual_cost: number;
  monthly_saving: number;
  unpriced_bytes: number;
  hot_reference_backend: string;
  backends: BackendBucket[];
  top_collections: CollectionCostRow[];
  recommendations: CostRecommendation[];
}
export interface CostSnapshot {
  cluster_id: string;
  backend_name: string;
  year_month: string;
  physical_bytes: number;
  logical_bytes: number;
  cost_estimate: number;
  counterfactual_cost: number;
  currency: string;
  captured_at: string;
}
export interface AIMigrationProposal {
  title: string;
  collection: string;
  from_backend: string;
  to_backend: string;
  bytes: number;
  monthly_saving: number;
  currency: string;
  rationale: string;
  task_command: string;
  risk: "low" | "medium" | "high";
  confidence: "low" | "medium" | "high";
}
export function usePricing() {
  return useSWR<{ items: BackendPricing[] }>(`${BASE}/pricing`, fetcher);
}
export function useCurrentCosts(clusterID?: string) {
  return useSWR<CostsResponse>(
    clusterID ? `${BASE}/costs/current?cluster_id=${clusterID}` : null, fetcher,
  );
}
export function useCostHistory(clusterID?: string, months = 12) {
  return useSWR<{ items: CostSnapshot[]; months: number }>(
    clusterID ? `${BASE}/costs/history?cluster_id=${clusterID}&months=${months}` : null, fetcher,
  );
}

// ---- Cost showback (attribution by owner / domain) ----
export interface ShowbackGroup {
  key: string;            // owner name, business domain, or "(unassigned)"
  buckets: number;
  physical_bytes: number;
  monthly_cost: number;
}
export interface ShowbackResponse {
  cluster_id: string;
  generated_at: string;
  currency: string;
  total_monthly_cost: number;
  total_bytes: number;
  unpriced_bytes: number;
  by_owner: ShowbackGroup[];
  by_domain: ShowbackGroup[];
}
export function useShowback(clusterID?: string) {
  return useSWR<ShowbackResponse>(
    clusterID ? `${BASE}/costs/showback?cluster_id=${clusterID}` : null, fetcher,
  );
}

// ---- Replication / Raft health ----
export interface ReplicaIssue {
  volume_id: number;
  collection: string;
  replica_placement: string;
  expected: number;
  observed: number;
  servers: string[];
  severity: "critical" | "warning" | "info";
  reason: string;
  is_ec: boolean;
}
export interface ECShardHealth {
  volume_id: number;
  collection: string;
  shard_count: number;
  servers: string[];
  missing_hint: boolean;
}
export interface ReplicationHealthResp {
  cluster_id: string;
  total_volumes: number;
  normal_volumes: number;
  ec_volumes: number;
  healthy_volumes: number;
  sole_copies: number;
  single_copy_volumes: number;
  under_replicated: number;
  over_replicated: number;
  ec_potentially_short_shards: number;
  issues: ReplicaIssue[];
  ec_shards_at_risk: ECShardHealth[];
}
export function useReplicationHealth(clusterID?: string) {
  return useSWR<ReplicationHealthResp>(
    clusterID ? `${BASE}/clusters/${clusterID}/replication-health` : null, fetcher,
    { refreshInterval: 15000 },
  );
}

// ---- Policy simulation ----
export interface PolicySimMatch {
  volume_id: number;
  collection: string;
  server: string;
  bytes: number;
  quiet_days: number;
  reads_30d: number;
  reason: string;
}
export interface PolicySimByCollection {
  collection: string;
  volumes: number;
  bytes: number;
}
export interface PolicySimResp {
  policy_id: string;
  policy_name: string;
  cluster_id: string;
  generated_at: string;
  effective_params: {
    min_quiet_days?: number;
    min_size_bytes?: number;
    max_reads_30d?: number;
    target_backend?: string;
    exclude_readonly?: boolean;
    collection_glob?: string;
  };
  matched_volumes: number;
  matched_bytes: number;
  skipped_volumes: number;
  considered_volumes: number;
  by_collection: PolicySimByCollection[];
  samples: PolicySimMatch[];
  skip_reasons: Record<string, number>;
  est_monthly_saving: number;
  est_saving_currency: string;
  hot_reference_backend: string;
  // Set only in time-machine mode — the snapshot instant the dry-run was
  // evaluated against. Absent means the run used live cluster state.
  as_of?: string;
}

// ---- Capacity incidents (auto-pause closed loop) ----
export interface IncidentAction {
  title: string;
  kind: string;     // expand | cold_migrate | pause | other
  detail: string;
  est_cost: string;
  est_eta: string;
  risk: string;     // low | medium | high
}
export interface IncidentReport {
  root_cause: string;
  summary: string;
  actions: IncidentAction[];
  provider: string;
  analyzed_at: string;
}
export interface CapacityIncident {
  id: string;
  cluster_id: string;
  cluster_name: string;
  status: "open" | "resolved";
  trigger_task_id?: string;
  failure_message: string;
  ai_report?: IncidentReport | null;
  triggered_at: string;
  resolved_at?: string;
  resolved_by?: string;
}
// Open incidents drive the dashboard banner; poll so a freshly auto-paused
// cluster surfaces without a manual refresh.
export function useCapacityIncidents(status: "open" | "resolved" | "" = "open") {
  return useSWR<{ items: CapacityIncident[]; total: number }>(
    `${BASE}/incidents${status ? `?status=${status}` : ""}`, fetcher,
    { refreshInterval: 30000 },
  );
}

// ---- Capacity forecast ("full in N days") ----
export interface CapacityForecast {
  cluster_id: string;
  cluster_name: string;
  used_bytes: number;
  capacity_bytes: number;
  percent_full: number;
  growth_bytes_per_day: number;
  days_to_full?: number;
  projected_full_at?: string;
  confidence: "none" | "low" | "medium" | "high";
  status: "no_data" | "stable" | "ok" | "warning" | "critical";
  sample_days: number;
  note: string;
}
// Forecasts move slowly (new snapshot per scoring pass) — no fast poll.
export function useCapacityForecast() {
  return useSWR<{ items: CapacityForecast[] }>(`${BASE}/capacity/forecast`, fetcher);
}

// ---- Path-scoped migration wizard ----
export interface PathPreviewResponse {
  cluster: string;
  filer: string;
  path: string;
  recursive: boolean;
  truncated: boolean;
  matched_files: number;
  total_bytes: number;
  oldest_mtime_seconds: number;
  newest_mtime_seconds: number;
  by_collection: { collection: string; files: number; bytes: number }[];
  by_extension: { ext: string; files: number; bytes: number }[];
  by_age: { label: string; files: number; bytes: number }[];
  samples: { FullPath: string; FileSize: number; Mtime: string; Mode: number; Collection: string }[];
  walked: number;
  filters: {
    path: string;
    recursive: boolean;
    glob?: string;
    min_size_bytes?: number;
    min_age_days?: number;
  };
}

// ---- Drain jobs ----
export type DrainStatus = "pending" | "running" | "verifying" | "done" | "failed" | "cancelled";
export interface DrainJob {
  id: string;
  cluster_id: string;
  node: string;
  status: DrainStatus;
  force: boolean;
  reason: string;
  requested_by: string;
  initial_volumes: number;
  initial_bytes: number;
  last_volumes: number;
  last_bytes: number;
  attempts: number;
  run_log: string;
  error: string;
  created_at: string;
  started_at?: string;
  finished_at?: string;
}
export function useDrains(clusterID?: string, status?: string) {
  const qs = new URLSearchParams();
  if (clusterID) qs.set("cluster_id", clusterID);
  if (status) qs.set("status", status);
  return useSWR<{ items: DrainJob[] }>(
    `${BASE}/drains${qs.toString() ? `?${qs}` : ""}`, fetcher,
    { refreshInterval: 5000 }, // keep the list fresh while drains run
  );
}
export function useDrain(id?: string) {
  return useSWR<DrainJob>(id ? `${BASE}/drains/${id}` : null, fetcher);
}

export function useVolumeTemperatures(collection?: string, limit = 5000) {
  const qs = new URLSearchParams();
  if (collection) qs.set("collection", collection);
  qs.set("limit", String(limit));
  return useSWR<{ items: VolumeTemperature[]; collection: string; limit: number }>(
    `${BASE}/temperature/volumes?${qs}`, fetcher,
  );
}
export function useTasks(s = "")   { return useSWR(`${BASE}/tasks${s ? `?status=${s}` : ""}`, fetcher); }
export function usePolicies()      { return useSWR(`${BASE}/policies`, fetcher); }

// ---- Policy ROI (per-policy task attribution) ----
export interface PolicyTaskStat {
  policy_id: string;
  total: number;
  pending: number;
  approved: number;
  running: number;
  succeeded: number;
  failed: number;
  other: number;
}
// Per-policy task rollup, keyed by policy id. A policy appears only once
// the scheduler has attributed tasks to its scope.
export function usePolicyROI() {
  return useSWR<{ items: Record<string, PolicyTaskStat> }>(`${BASE}/policies/roi`, fetcher);
}

// ---- AI migration-policy advisor ----
export interface PolicyRecommendation {
  name: string;
  scope_kind: string;
  scope_value: string;
  strategy: string;
  params: Record<string, unknown>;
  sample_rate: number;
  dry_run: boolean;
  rationale: string;
  expected_volumes: number;
  expected_bytes: number;
  confidence: "high" | "medium" | "low";
}
export interface PolicyAdviceResp {
  generated_at: string;
  provider: string;
  summary: string;
  recommendations: PolicyRecommendation[];
}

// ---- AI volume-balance advisor ----
export interface BalanceRecommendation {
  title: string;
  collection: string;
  data_center: string;
  writable: boolean;
  rationale: string;
  confidence: "high" | "medium" | "low";
}
export interface BalanceAdviceResp {
  generated_at: string;
  provider: string;
  severity: "balanced" | "minor" | "significant" | "severe";
  summary: string;
  recommendations: BalanceRecommendation[];
}
export function useAudit(filter?: { actor?: string; action?: string; kind?: string; targetID?: string; since?: string; limit?: number }) {
  const qs = new URLSearchParams();
  if (filter?.actor)    qs.set("actor", filter.actor);
  if (filter?.action)   qs.set("action", filter.action);
  if (filter?.kind)     qs.set("target_kind", filter.kind);
  if (filter?.targetID) qs.set("target_id", filter.targetID);
  if (filter?.since)    qs.set("since", filter.since);
  if (filter?.limit)    qs.set("limit", String(filter.limit));
  const s = qs.toString();
  return useSWR(`${BASE}/audit${s ? `?${s}` : ""}`, fetcher);
}
export function useAuditFacets() { return useSWR(`${BASE}/audit/facets`, fetcher); }

// Audit AI summary — POST endpoint, not SWR. The operator triggers it
// explicitly (button click) so we expose a function rather than a hook.
export interface AuditSummaryResp {
  ok: boolean;
  empty?: boolean;
  hours: number;
  row_count: number;
  truncated?: boolean;
  provider_name?: string;
  summary?: {
    headline: string;
    narrative: string;
    highlights: string[];
    risks: string[];
  };
  facets?: {
    by_action: { key: string; count: number }[];
    by_actor:  { key: string; count: number }[];
    by_kind:   { key: string; count: number }[];
  };
  error?: string;
  raw?: string;
}

// Fleet-wide cost overview. Aggregates monthly snapshots across all
// clusters + a 3-month linear forecast. ai_explainer is best-effort
// prose; it never modifies the numeric fields.
export interface FleetMonthPoint {
  year_month: string;
  cost_estimate: number;
  counterfactual_cost: number;
  physical_bytes: number;
  forecast?: boolean;
}
export interface FleetClusterRow {
  cluster_id: string;
  name: string;
  cost_estimate: number;
  physical_bytes: number;
  mom_delta: number;
  has_mom_base: boolean;
}
export interface FleetCostResp {
  months: number;
  currency: string;
  series: FleetMonthPoint[];
  clusters: FleetClusterRow[];
  forecast_trend: "rising" | "falling" | "flat" | "insufficient_data";
  slope: number;
  ai_explainer?: string;
  ai_provider?: string;
}
export function useFleetCost(months = 12, explain = false) {
  const url = `${BASE}/costs/fleet?months=${months}${explain ? "&explain=true" : ""}`;
  return useSWR<FleetCostResp>(url, fetcher);
}

// Alert triage. Read-only narrative over recent alert events:
// fingerprints, storms (silence candidates), priorities (investigate
// first). Like auditSummary, no counterfactual — it's a comprehension
// aid, not a decision pipeline.
export interface AlertTriageFingerprint {
  event_kind: string;
  source: string;
  count: number;
  first_fired: string;
  last_fired: string;
  severities: string[];
  suppressed: number;
}
export interface AlertTriageResp {
  ok: boolean;
  empty?: boolean;
  hours: number;
  row_count: number;
  severity_min?: string;
  truncated?: boolean;
  provider_name?: string;
  summary?: {
    headline: string;
    narrative: string;
    storms: { event_kind: string; source: string; count: number; reason: string }[];
    priorities: { event_kind: string; source: string; severity: string; reason: string }[];
  };
  facets?: {
    by_severity: { key: string; count: number }[];
    by_kind:     { key: string; count: number }[];
    by_source:   { key: string; count: number }[];
    fingerprints: AlertTriageFingerprint[];
  };
  error?: string;
  raw?: string;
}
export async function alertTriage(body: {
  hours?: number;
  severity_min?: "info" | "warning" | "critical";
  question?: string;
}): Promise<AlertTriageResp> {
  return jpost(`${BASE}/alerts/triage`, body) as Promise<AlertTriageResp>;
}

// Bucket-level cost AI plan. Per-bucket lifecycle proposals + counterfactual
// learning. Persisted server-side so the operator's approve/discard
// updates the AI Learning panel.
export interface BucketCostProposal {
  proposal_id?: string;
  bucket: string;
  action: "set_quota" | "cleanup_uploads" | "review_for_deletion" | "investigate_tiering";
  value: Record<string, unknown>;
  risk: "low" | "medium" | "high";
  confidence?: string;
  explanation: string;
  est_monthly_saving: number;
}
export interface BucketCostPlanResp {
  ok: boolean;
  empty?: boolean;
  message?: string;
  error?: string;
  summary?: string;
  proposals?: BucketCostProposal[];
  total_saving?: number;
  currency?: string;
  warnings?: string[];
  provider_name?: string;
  raw?: string;
}
export async function bucketCostPlan(clusterID: string, body: { extra_context?: string; max_proposals?: number } = {}) {
  return jpost(`${BASE}/clusters/${clusterID}/buckets/cost-plan`, body) as Promise<BucketCostPlanResp>;
}
export async function bucketCostPlanDecide(proposalID: string, body: {
  decision: "approved" | "discarded" | "edited";
  applied_value?: Record<string, unknown>;
}) {
  return jpost(`${BASE}/ai/bucket-cost-proposals/${proposalID}/decide`, body) as Promise<{ ok: boolean }>;
}
export interface BucketCostLearningResp {
  hours: number;
  total: number;
  approved: number;
  edited: number;
  discarded: number;
  accept_rate: number;
  precision_rate: number;
  open_proposals: number;
  realised_saving: number;
  currency: string;
  by_risk: { risk: string; total: number; approved: number; accept_rate: number }[];
  by_action: { action: string; total: number; approved: number; accept_rate: number }[];
}

// Identity key-rotation reminder. Read-only — combines `s3.configure -list`
// with our audit log to estimate "how long since this access key was
// last rotated". `unknown` means the identity has access keys but no
// upsert ever passed through the controller; treat with a softer tone
// than `stale` since the secret could have been rotated via the CLI.
export interface IdentityRotationRow {
  name: string;
  access_key_count: number;
  last_rotated_at?: string;
  age_days?: number;
  status: "ok" | "stale" | "unknown";
}
export interface IdentityRotationResp {
  threshold_days: number;
  total: number;
  stale_count: number;
  unknown_count: number;
  without_keys: number;
  identities: IdentityRotationRow[];
}

export async function auditSummary(body: {
  hours?: number;
  actor?: string;
  action?: string;
  target_kind?: string;
  question?: string;
}): Promise<AuditSummaryResp> {
  return jpost(`${BASE}/audit/summary`, body) as Promise<AuditSummaryResp>;
}
export function useTask(id?: string) {
  return useSWR(id ? `${BASE}/tasks/${id}` : null, fetcher);
}
// Live: task autonomy waterfall updates as steps progress.
export function useTaskAutonomy(id?: string) {
  return useSWR(id ? `${BASE}/tasks/${id}/autonomy` : null, fetcher, { refreshInterval: 10_000 });
}
export function useClusterPressure() {
  return useSWR(`${BASE}/clusters/pressure`, fetcher);
}
export function useExecution(id?: string) {
  // Poll fast while running, slow once terminal — keeps the running waterfall
  // responsive without hammering PG forever after the task finishes.
  return useSWR(id ? `${BASE}/executions/${id}` : null, fetcher, {
    refreshInterval: (data: { status?: string } | undefined) =>
      data && data.status && data.status !== "running" ? 30_000 : 1_500,
  });
}
export function useAIProviders()   { return useSWR(`${BASE}/ai/providers`, fetcher); }
export function useClusters()      { return useSWR(`${BASE}/clusters`,   fetcher); }
export function useClusterTopology(id?: string) { return useSWR(id ? `${BASE}/clusters/${id}/topology` : null, fetcher); }
// Real-bytes physical disk usage. Backend fan-outs to each volume server's
// /status and 30s-caches the aggregate; we refresh on the same cadence.
export function useClusterDisk(id?: string) {
  return useSWR(id ? `${BASE}/clusters/${id}/disk` : null, fetcher, { refreshInterval: 30000 });
}
export function useClusterTags(id?: string)     { return useSWR(id ? `${BASE}/clusters/${id}/tags` : null, fetcher); }
export function useHolidays()      { return useSWR(`${BASE}/holidays`, fetcher); }

export function useTrend(range: "1d"|"7d"|"30d" = "7d") {
  const res = range === "30d" ? "day" : "hour";
  return useSWR(`${BASE}/trend?range=${range}&res=${res}`, fetcher);
}
export function useTrendByDomain(range: "1d"|"7d"|"30d" = "7d") {
  const res = range === "30d" ? "day" : "hour";
  return useSWR(`${BASE}/trend/by-domain?range=${range}&res=${res}`, fetcher);
}
export function useConfig() { return useSWR(`${BASE}/config`, fetcher); }
export function useConfigHistory(key?: string) {
  return useSWR(key ? `${BASE}/config/${encodeURIComponent(key)}/history` : null, fetcher);
}
export function useBackends() { return useSWR(`${BASE}/backends`, fetcher); }
export function useMonitorTargets() { return useSWR(`${BASE}/monitor/targets`, fetcher); }
export function useHealthGate()      { return useSWR(`${BASE}/health/gate`,    fetcher); }
export function useHealthSamples(id?: string) {
  return useSWR(id ? `${BASE}/monitor/targets/${id}/samples` : null, fetcher);
}
export function useAnalyzerScripts() { return useSWR<{ items: AnalyzerScript[] }>(`${BASE}/analyzer/scripts`, fetcher); }
export function useAnalyzerRuns(id?: string) {
  return useSWR(id ? `${BASE}/analyzer/scripts/${id}/runs?limit=50` : null, fetcher);
}
export function useAnalyzerVersions(id?: string) {
  return useSWR<{ items: AnalyzerScriptVersion[] }>(id ? `${BASE}/analyzer/scripts/${id}/versions` : null, fetcher);
}

export interface AnalyzerScriptVersion {
  id: number;
  script_id: string;
  version: number;
  title: string;
  description: string;
  body: string;
  params: AnalyzerScriptParam[];
  reason: string;
  actor: string;
  at: string;
}

export interface AnalyzerScriptParam {
  name: string;
  type: "string" | "int" | "bool" | "enum";
  required?: boolean;
  default?: unknown;
  doc?: string;
  enum?: string[];
}

export interface AnalyzerScript {
  id: string;
  name: string;
  title: string;
  description: string;
  for_commands: string[];
  tags: string[];
  params: AnalyzerScriptParam[];
  body: string;
  sample_input: string;
  sample_output?: unknown;
  enabled: boolean;
  origin: "system" | "user";
  version: number;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface AnalyzerRunResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  stderr?: string;
  elapsed_ms: number;
  input_hash: string;
  input_size: number;
}

export function useAlertChannels() { return useSWR(`${BASE}/alerts/channels`, fetcher); }
export function useAlertRules()    { return useSWR(`${BASE}/alerts/rules`,    fetcher); }
export function useAlertEvents()   { return useSWR(`${BASE}/alerts/events?limit=100`, fetcher); }
export function useAlertTemplates(){ return useSWR(`${BASE}/alerts/templates`, fetcher); }

export interface AlertTemplate {
  id: string;
  name: string;
  description: string;
  title_tmpl: string;
  body_tmpl: string;
  severity: "info" | "warning" | "critical";
  created_at: string;
  updated_at: string;
}

export interface OpsTemplateAlerts {
  channel_ids: string[];
  alert_template_id?: string | null;
  on_start: boolean;
  on_success: boolean;
  on_failure: boolean;
  on_await_confirm: boolean;
  severity?: "info" | "warning" | "critical" | "";
}
export function useSafetyStatus()  { return useSWR(`${BASE}/safety/status`,  fetcher); }
export function useBlocklist()     { return useSWR(`${BASE}/safety/blocklist`, fetcher); }
export function useMaintenance()   { return useSWR(`${BASE}/safety/maintenance`, fetcher); }

export function useSkills(scope: "" | "system" | "custom" = "") {
  return useSWR(`${BASE}/skills${scope ? `?scope=${scope}` : ""}`, fetcher);
}
export function useSkillHistory(key?: string) {
  return useSWR(key ? `${BASE}/skills/${encodeURIComponent(key)}/history` : null, fetcher);
}
export function useVolumePattern(id?: string | number) {
  return useSWR(id != null ? `${BASE}/volumes/${id}/pattern` : null, fetcher);
}
export function useCohortBaselines() {
  return useSWR(`${BASE}/cohort/baselines`, fetcher);
}
export function useCohortAnomalies(domain = "", limit = 100) {
  const qs = new URLSearchParams();
  if (domain) qs.set("domain", domain);
  qs.set("limit", String(limit));
  return useSWR(`${BASE}/cohort/anomalies?${qs.toString()}`, fetcher);
}
export function useCohortBreakdown() {
  return useSWR(`${BASE}/cohort/breakdown`, fetcher);
}
// Live: review status updates as the worker progresses.
export function useTaskReview(taskId?: string) {
  return useSWR(taskId ? `${BASE}/tasks/${taskId}/review` : null, fetcher, { refreshInterval: 5_000 });
}
export function useAILearning(hours = 24) {
  return useSWR(`${BASE}/ai/learning?hours=${hours}`, fetcher);
}

// S3 policy proposal acceptance metrics — counterpart of useAILearning
// for the NL → IAM generator. Renders as its own card on the AI
// Learning panel.
export interface AIS3LearningResp {
  hours: number;
  total: number;
  approved: number;
  edited: number;
  discarded: number;
  accept_rate: number;
  precision_rate: number;
  open_proposals: number;
  by_risk: { risk: "low" | "medium" | "high"; total: number; approved: number; accept_rate: number }[];
}
export function useAIS3Learning(hours = 168) {
  return useSWR<AIS3LearningResp>(`${BASE}/ai/s3-learning?hours=${hours}`, fetcher);
}

// Circuit-breaker limit proposal acceptance — second AI Learning card.
// Shape mirrors AIS3LearningResp on purpose so the UI uses one component.
export interface AIS3LimitLearningResp {
  hours: number;
  total: number;
  approved: number;
  edited: number;
  discarded: number;
  accept_rate: number;
  precision_rate: number;
  open_proposals: number;
  by_risk: { risk: "low" | "medium" | "high"; total: number; approved: number; accept_rate: number }[];
}
export function useAIS3LimitLearning(hours = 168) {
  return useSWR<AIS3LimitLearningResp>(`${BASE}/ai/s3-limit-learning?hours=${hours}`, fetcher);
}

export function useBucketCostLearning(hours = 168) {
  return useSWR<BucketCostLearningResp>(`${BASE}/ai/bucket-cost-learning?hours=${hours}`, fetcher);
}

// ---------------- ops / weed shell ----------------

export interface ShellArg {
  flag: string;
  label: string;
  kind: "string" | "int" | "bool" | "enum";
  required?: boolean;
  default?: string;
  help?: string;
  enum?: string[];
}
export interface ShellCommand {
  name: string;
  category: string;
  risk: "read" | "mutate" | "destructive";
  summary: string;
  args?: ShellArg[];
  read_only?: boolean;
  streams?: boolean;
}

export function useShellCatalog() {
  // Include the current UI language in the SWR cache key so a
  // mid-session locale switch invalidates the cached English (or
  // Chinese) catalog and triggers a refetch. Without this, the
  // operator would have to hard-reload after toggling languages
  // before the command list flips to the new locale.
  return useSWR<{ items: ShellCommand[] }>(
    [`${BASE}/shell/catalog`, currentLang()],
    ([url]) => fetcher(url),
  );
}
export function useClusterHealth(id?: string) {
  return useSWR<{ reachable: boolean; latency_ms: number; error?: string; master: string }>(
    id ? `${BASE}/clusters/${id}/health` : null,
    fetcher,
  );
}
export interface OpsCapture {
  as: string;
  regex: string;
}
export interface OpsVarInference {
  var: string;
  from_step?: number;
  hint: string;
}
export interface OpsStepPos {
  x: number;
  y: number;
}
export interface OpsStep {
  /** Stable identifier referenced by other steps' depends_on. Server
   *  fills in a short slug ("s1", "s2") when missing so legacy
   *  templates and AI drafts stay valid. */
  id?: string;
  /** "shell" (default) runs Command via weed shell. "analyzer" runs
   *  an analyzer_scripts row against a prior step's stdout. */
  kind?: "shell" | "analyzer";
  command: string;
  args?: string;
  reason?: string;
  pause_on_error?: boolean;
  capture?: OpsCapture[];
  streams?: boolean;
  // Interactive runner extensions:
  confirm_before?: boolean;
  infer_vars?: OpsVarInference[];
  /** Step ids that must finish successfully before this one runs.
   *  Empty/missing = root node; siblings with the same depends_on
   *  execute in parallel. */
  depends_on?: string[];
  /** Saved canvas coordinates for the flow editor. Auto-laid-out
   *  when missing. */
  position?: OpsStepPos;
  /** Per-step config when kind="analyzer". */
  analyzer?: OpsStepAnalyzer;
}

export interface OpsStepAnalyzer {
  script_name: string;
  from_step?: string;
  params?: Record<string, string>;
}
export interface OpsVariable {
  key: string;
  label?: string;
  required?: boolean;
  default?: string;
  help?: string;
}
export interface OpsTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  steps: OpsStep[] | string;  // server returns json.RawMessage; some envelopes serialize as string
  variables?: OpsVariable[];
  /** When true, the interactive runner auto-asks the AI for a short
   *  risk/watch-out/rollback brief on every mutating step. Pure advisory
   *  — never blocks. Operators can also trigger the check manually from
   *  the approval card regardless of this flag. */
  ai_precheck?: boolean;
  /** Per-flow alert routing. null = no alerts configured. */
  alerts?: OpsTemplateAlerts | null;
  created_by?: string;
  updated_by?: string;
  created_at?: string;
  updated_at?: string;
}

export interface OpsPrecheckAdvice {
  risk?: string;
  watch_out?: string;
  rollback?: string;
}
export interface OpsPrecheckResponse {
  ok: boolean;
  advice?: OpsPrecheckAdvice;
  error?: string;
}

export function useOpsTemplates() {
  return useSWR<{ items: OpsTemplate[] }>(`${BASE}/ops/templates`, fetcher);
}

export interface BucketRow {
  name: string;
  size: number;
  chunks: number;
  quota?: number;
  usage_pc?: number;
  owner?: string;                 // S3 IAM owner (read from the cluster)
  // Controller-side governance (owner + data lifecycle):
  owner_name?: string;            // responsible person
  owner_user_key?: string;        // user key / employee id
  retention_days?: number;        // data older than this is flagged expired
  notes?: string;
  last_scan_at?: string;
  expired_objects?: number;
  expired_bytes?: number;
  scan_truncated?: boolean;
}
export function useBuckets(clusterID?: string) {
  return useSWR<{ items: BucketRow[] }>(
    clusterID ? `${BASE}/clusters/${clusterID}/buckets` : null,
    fetcher,
  );
}

// ---- S3 multipart uploads (stale upload inspection) ----
// Mirrors the JSON shape returned by GET /clusters/:id/s3/multipart-uploads.
// Each row is one upload-in-progress that the operator (or AI tool) may
// classify as abandoned / suspicious / in-flight and selectively abort.
export interface MultipartUpload {
  bucket: string;
  key: string;            // best-effort; empty when filer doesn't expose it
  upload_id: string;
  initiated_at: string;   // RFC3339
  age_hours: number;
  size_so_far: number;    // bytes summed across uploaded parts
  part_count: number;
}

// ---- Data lifecycle (cross-cluster governed buckets) ----
export interface GovernedBucket {
  id: string;
  cluster_id: string;
  cluster_name: string;
  bucket_name: string;
  owner_name: string;
  owner_user_key: string;
  retention_days?: number;
  notes: string;
  last_scan_at?: string;
  expired_objects: number;
  expired_bytes: number;
  scan_truncated: boolean;
  expired_sample?: string[];
  updated_at: string;
}
export function useGovernedBuckets() {
  return useSWR<{ items: GovernedBucket[] }>(`${BASE}/lifecycle/buckets`, fetcher);
}

export interface CollectionRow {
  name: string;
  volume_count: number;
  size: number;
  file_count: number;
  deleted_bytes: number;
  delete_count: number;
}
export function useCollections(clusterID?: string) {
  return useSWR<{ items: CollectionRow[] }>(
    clusterID ? `${BASE}/clusters/${clusterID}/collections` : null,
    fetcher,
  );
}

export interface ClusterMasterRow {
  address: string;
  reachable: boolean;
  latency_ms: number;
  is_leader: boolean;
  suffrage: "leader" | "voter" | "nonvoter" | "unknown";
  reported_leader?: string;
  reported_peers: string[];
  normalized_peers: string[];
  lock_holder?: string;
  warnings: string[];
  health: "ok" | "warn" | "err";
  error?: string;
}

export interface MasterConsistencyIssue {
  code: string;
  message: string;
}

export interface MasterConsistency {
  healthy: boolean;
  leader_agreement: boolean;
  peer_set_agreement: boolean;
  expected_peers: string[];
  reported_leaders: string[];
  issues: MasterConsistencyIssue[];
}

export interface ClusterMastersResponse {
  cluster: { id: string; name: string; master_addr: string };
  configured_master: string;
  masters: ClusterMasterRow[];
  consistency: MasterConsistency;
}

export function useClusterMasters(clusterID?: string) {
  return useSWR<ClusterMastersResponse>(
    clusterID ? `${BASE}/clusters/${clusterID}/masters` : null,
    fetcher,
  );
}

export interface ClusterFilerRow {
  address: string;
  version?: string;
  data_center?: string;
  rack?: string;
  created_at_ns?: number;
  reachable: boolean;
  latency_ms?: number;
  probe_error?: string;
  health: "ok" | "warn" | "err";
  source: "master" | "config" | "master+config";
}

export interface ClusterFilersResponse {
  configured_master: string;
  master_list_error?: string;
  filers: ClusterFilerRow[];
}

export function useClusterFilers(clusterID?: string) {
  return useSWR<ClusterFilersResponse>(
    clusterID ? `${BASE}/clusters/${clusterID}/filers` : null,
    fetcher,
  );
}

export interface VolumeDetailResponse {
  id: number;
  collection: string;
  is_ec: boolean;
  replica_place: number;
  placement: string;
  read_only: boolean;
  total_size: number;
  file_count: number;
  delete_count: number;
  deleted_bytes: number;
  replica_count: number;
  ec_shard_count: number;
  ec_shards_present: number[];
  ec_shards_missing: number[];
  servers: string[];
  replicas: VolumeReplicaRow[];
}

export function useVolumeDetail(clusterID?: string, vid?: number | string) {
  return useSWR<VolumeDetailResponse>(
    clusterID && vid != null && vid !== ""
      ? `${BASE}/clusters/${clusterID}/volumes/${encodeURIComponent(String(vid))}`
      : null,
    fetcher,
  );
}

export interface ECShardLocation {
  shard: number;
  server: string;
  rack?: string;
  data_center?: string;
  size?: number;
}

export interface ECVolumeMatrixRow {
  id: number;
  collection: string;
  total_size: number;
  shards_by_index: Record<string, ECShardLocation[]>;
  missing: number[];
  present: number[];
  shards_present: number;
  shards_missing: number;
  healthy: boolean;
}

export interface ECShardsResponse {
  total_shards: number;
  volumes: ECVolumeMatrixRow[];
}

// File Browser ---------------------------------------------------------------

// Mirror of seaweed filer.Entry: directory listings return one of these
// per child. `chunks` and the placement detail are intentionally omitted
// — the browser only needs name/size/mode/mtime to render rows.
export interface FilerEntry {
  FullPath: string;
  Mtime?: string;
  Mode?: number; // unix mode; high bits flag directories
  FileSize?: number;
  Mime?: string;
}

export interface FilerListing {
  Path: string;
  Entries: FilerEntry[] | null;
  Limit: number;
  LastFileName?: string;
  ShouldDisplayLoadMore?: boolean;
  EmptyFolder?: boolean;
}

export interface ClusterFilesResponse {
  filer: string;
  path: string;
  listing: FilerListing;
}

export function useClusterFiles(clusterID?: string, dirPath?: string, filer?: string) {
  const qs = new URLSearchParams();
  if (dirPath) qs.set("path", dirPath);
  if (filer) qs.set("filer", filer);
  return useSWR<ClusterFilesResponse>(
    clusterID ? `${BASE}/clusters/${clusterID}/files?${qs.toString()}` : null,
    fetcher,
  );
}

export function useClusterECShards(clusterID?: string) {
  return useSWR<ECShardsResponse>(
    clusterID ? `${BASE}/clusters/${clusterID}/ec-shards` : null,
    fetcher,
  );
}

export interface ECVolumeHostSummary {
  server: string;
  rack?: string;
  data_center?: string;
  shard_count: number;
  shards: number[];
  size: number;
}

export interface ECVolumeDetailResponse {
  id: number;
  collection: string;
  total_size: number;
  total_shards: number;
  shards_present: number;
  shards_missing: number;
  present: number[];
  missing: number[];
  healthy: boolean;
  shards_by_index: Record<string, ECShardLocation[]>;
  hosts: ECVolumeHostSummary[];
  data_centers: string[];
  racks: string[];
}

export function useECVolumeDetail(clusterID?: string, vid?: number | string) {
  return useSWR<ECVolumeDetailResponse>(
    clusterID && vid != null && vid !== ""
      ? `${BASE}/clusters/${clusterID}/ec-volumes/${encodeURIComponent(String(vid))}`
      : null,
    fetcher,
  );
}

export interface DiskSummary {
  disk_type: string;
  volume_count: number;
  max_volume_count: number;
  free_volume_count: number;
  used_bytes: number;
}

export interface VolumeReplicaRow {
  ID: number;
  Collection: string;
  Size: number;
  FileCount: number;
  DeleteCount: number;
  DeletedBytes: number;
  ReadOnly: boolean;
  ReplicaPlace: number;
  DiskType?: string;
  Server: string;
  Rack?: string;
  DataCenter?: string;
  ModifiedAtSec?: number;
  RemoteStorageName?: string;
  RemoteStorageKey?: string;
  IsEC: boolean;
  Shards?: number[];
  ShardSizes?: number[];
}

export interface VolumeServerDetail {
  address: string;
  data_center: string;
  rack: string;
  volume_count: number;
  used_bytes: number;
  max_volumes: number;
  free_volumes: number;
  ec_shard_count: number;
  read_only_count: number;
  disks: DiskSummary[];
  volumes: VolumeReplicaRow[];
}

export function useVolumeServer(clusterID?: string, addr?: string) {
  return useSWR<VolumeServerDetail>(
    clusterID && addr
      ? `${BASE}/clusters/${clusterID}/volume-servers/${encodeURIComponent(addr)}`
      : null,
    fetcher,
  );
}

export interface CollectionDetail {
  name: string;
  volume_count: number;
  replica_row_count: number;
  total_size: number;
  file_count: number;
  deleted_bytes: number;
  delete_count: number;
  ec_volume_count: number;
  read_only_volumes: number;
  replication_distribution: Record<string, number>;
  server_distribution: Record<string, number>;
  volumes: VolumeReplicaRow[];
}

export function useCollectionDetail(clusterID?: string, name?: string) {
  // Master sentinel: empty (default) collection is encoded as "_default_"
  // by the global /collections page so the URL stays representable.
  return useSWR<CollectionDetail>(
    clusterID && name != null
      ? `${BASE}/clusters/${clusterID}/collections/${encodeURIComponent(name || "_default_")}`
      : null,
    fetcher,
  );
}

export function useShellHelp(clusterID?: string, cmd?: string) {
  return useSWR<{ command: string; help: string }>(
    clusterID && cmd ? `${BASE}/clusters/${clusterID}/shell/help?cmd=${encodeURIComponent(cmd)}` : null,
    fetcher,
  );
}

// ---------------- mutations ----------------

export const api = {
  approveTask:  (id: string) => jpost(`${BASE}/tasks/${id}/approve`),
  cancelTask:   (id: string) => jpost(`${BASE}/tasks/${id}/cancel`),
  runTask:      (id: string) => jpost(`${BASE}/tasks/${id}/run`),
  stopTask:     (id: string) => jpost(`${BASE}/tasks/${id}/stop`),
  retryTask:    (id: string) => jpost(`${BASE}/tasks/${id}/retry`),
  latestExecForTask: async (id: string): Promise<{ id: string } | null> => {
    const r = await fetch(`${BASE}/tasks/${id}/latest-execution`, { headers: authHeaders() });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    return r.json();
  },
  rollbackExec: (id: string) => jpost(`${BASE}/executions/${id}/rollback`),
  runPostmortem:    (execID: string) => jpost(`${BASE}/executions/${execID}/postmortem`),
  applyPostmortem:  (execID: string) => jpost(`${BASE}/executions/${execID}/apply-postmortem`),
  scoreNow:     (clusterID?: string) =>
    jpost(`${BASE}/scheduler/score-now${clusterID ? `?cluster_id=${encodeURIComponent(clusterID)}` : ""}`),
  testAI:       (b: unknown) => jpost(`${BASE}/ai/test`, b),
  upsertPolicy: (b: unknown) => jpost(`${BASE}/policies`, b, "PUT"),
  aiRecommendPolicies: () =>
    jpost(`${BASE}/ai/policy-recommendations`) as Promise<PolicyAdviceResp>,
  aiBalanceAdvice: (clusterID: string) =>
    jpost(`${BASE}/clusters/${clusterID}/volume/balance/ai-advice`) as Promise<BalanceAdviceResp>,
  listPermissions: async () => {
    const r = await fetch(`${BASE}/permissions`, { headers: authHeaders() });
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    return r.json() as Promise<{
      capabilities: { name: string; category: string; label: string; description: string }[];
      role_capabilities: { role: string; capability: string }[];
      roles: string[];
    }>;
  },
  setRolePermissions: (role: string, caps: string[]) =>
    jpost(`${BASE}/permissions/${encodeURIComponent(role)}`, { capabilities: caps }, "PUT"),

  // --- Volume operations (Phase 2) ---
  balancePlan: (clusterID: string, b: { collection?: string; data_center?: string; rack?: string }) =>
    jpost(`${BASE}/clusters/${clusterID}/volume/balance/plan`, b) as Promise<{
      moves: { volume_id: number; from: string; to: string; collection?: string; size_mb?: number }[];
      output: string;
    }>,
  volumeGrow: (clusterID: string, b: {
    collection: string; replication?: string; data_center?: string; rack?: string; count: number;
  }) => jpost(`${BASE}/clusters/${clusterID}/volume/grow`, b) as Promise<{ output: string; args: string }>,
  volumeDeleteEmpty: (clusterID: string, b: { volume_id: number; node: string }) =>
    jpost(`${BASE}/clusters/${clusterID}/volume/delete-empty`, b) as Promise<{ output: string }>,

  // --- volume.fix.replication ---
  volumeFixReplicationPlan: (clusterID: string, b: {
    collectionPattern?: string; doDelete?: boolean; doCheck?: boolean;
    verbose?: boolean; maxParallelization?: number; retry?: number; volumesPerStep?: number;
  } = {}) =>
    jpost(`${BASE}/clusters/${clusterID}/volume/fix-replication/plan`, b) as Promise<{
      summary: {
        issues: { volume_id: number; placement: string; kind: "under" | "over" | "misplaced"; delta?: number; locations?: string }[];
        under_replicated: number;
        over_replicated: number;
        misplaced: number;
      };
      output: string;
    }>,

  // --- EC dry-run plans ---
  ecRebuildPlan: (clusterID: string, b: {
    collection?: string; diskType?: string; maxParallelization?: number;
  } = {}) =>
    jpost(`${BASE}/clusters/${clusterID}/ec/rebuild/plan`, b) as Promise<{
      summary: {
        degraded: { volume_id: number; collection?: string; missing_shards: number[]; rebuildable: boolean }[];
        rebuildable: number;
        unrecoverable: number;
      };
      output: string;
    }>,
  ecBalancePlan: (clusterID: string, b: {
    collection?: string; dataCenter?: string; diskType?: string;
    shardReplicaPlacement?: string; maxParallelization?: number;
  } = {}) =>
    jpost(`${BASE}/clusters/${clusterID}/ec/balance/plan`, b) as Promise<{
      moves: number;
      output: string;
    }>,
  ecEncode: (clusterID: string, b: {
    collection?: string;
    volumeIds?: number[];
    fullPercent?: number;
    quietFor?: string;
    sourceDiskType?: string;
    diskType?: string;
    shardReplicaPlacement?: string;
    maxParallelization?: number;
    rebalance?: boolean;
    force?: boolean;
  }) => jpost(`${BASE}/clusters/${clusterID}/ec/encode`, b) as Promise<{
    output: string; args: string[]; error?: string;
  }>,
  ecDecode: (clusterID: string, b: {
    collection?: string;
    volumeIds?: number[];
    diskType?: string;
  }) => jpost(`${BASE}/clusters/${clusterID}/ec/decode`, b) as Promise<{
    output: string; error?: string; failed_volumes?: number[];
  }>,

  // --- Cluster operations (Phase 3) ---
  clusterCheckDisk: (clusterID: string, b: { volume_id?: number } = {}) =>
    jpost(`${BASE}/clusters/${clusterID}/check-disk`, b) as Promise<{
      rows: { volume_id: number; server: string; ok: boolean; message?: string }[];
      output: string;
    }>,
  // --- File Browser ---
  // Bearer auth lives in localStorage, so we can't use a plain <a href>
  // for download (the browser strips Authorization on link navigation).
  // Instead, fetch with auth, materialise a blob URL, and synthesize a
  // click — works fine for the ops-typical sub-100MB downloads.
  filesDownload: async (clusterID: string, filer: string, p: string) => {
    const qs = new URLSearchParams({ filer, path: p });
    const r = await fetch(`${BASE}/clusters/${clusterID}/files/download?${qs.toString()}`, {
      headers: authHeaders(),
    });
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const name = p.split("/").filter(Boolean).pop() || "download";
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
  filesUpload: async (clusterID: string, filer: string, dirPath: string, file: File,
                      onProgress?: (loaded: number, total: number) => void) => {
    const qs = new URLSearchParams({ filer, path: dirPath });
    const form = new FormData();
    form.append("file", file, file.name);
    // When a progress callback is supplied we route through XHR (fetch
    // has no upload progress event in browsers). Without one we keep
    // the original fetch path to avoid behavioural drift.
    if (!onProgress) {
      const r = await fetch(`${BASE}/clusters/${clusterID}/files/upload?${qs.toString()}`, {
        method: "POST", body: form, headers: authHeaders(),
      });
      if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
      return r.json() as Promise<{ name: string; size?: number }>;
    }
    return await new Promise<{ name: string; size?: number }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${BASE}/clusters/${clusterID}/files/upload?${qs.toString()}`);
      for (const [k, v] of Object.entries(authHeaders())) xhr.setRequestHeader(k, v);
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded, e.total); };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try { resolve(JSON.parse(xhr.responseText)); }
          catch { resolve({ name: file.name, size: file.size }); }
        } else {
          reject(new Error(`${xhr.status} ${xhr.responseText}`));
        }
      };
      xhr.onerror = () => reject(new Error("network error"));
      xhr.send(form);
    });
  },
  filesDelete: async (clusterID: string, filer: string, p: string, recursive: boolean) => {
    const qs = new URLSearchParams({ filer, path: p, recursive: recursive ? "true" : "false" });
    const r = await fetch(`${BASE}/clusters/${clusterID}/files?${qs.toString()}`, {
      method: "DELETE", headers: authHeaders(),
    });
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    return r.json() as Promise<{ deleted: string; recursive: boolean }>;
  },
  filesMkdir: (clusterID: string, body: { path: string; filer: string }) =>
    jpost(`${BASE}/clusters/${clusterID}/files/mkdir`, body) as Promise<{ created: string }>,

  lockProbe: (
    clusterID: string,
    b?: { address?: string; lock_name?: string },
  ) =>
    jpost(`${BASE}/clusters/${clusterID}/masters/lock-probe`, b ?? {}) as Promise<{
      status: "free" | "held" | "quorum_unhealthy";
      address: string;
      lock_name: string;
      holder?: string;
      message?: string;
      latency_ms?: number;
    }>,
  clusterConfigureReplication: (clusterID: string, b: { collection?: string; replication: string; volume_id?: number }) =>
    jpost(`${BASE}/clusters/${clusterID}/replication`, b) as Promise<{ output: string; args: string }>,
  clusterVolumeServerLeave: (clusterID: string, b: { node: string; force?: boolean }) =>
    jpost(`${BASE}/clusters/${clusterID}/volume-server/leave`, b) as Promise<{ output: string }>,

  // --- S3 (Phase 4) ---
  s3ListIdentities: async (clusterID: string) => {
    const r = await fetch(`${BASE}/clusters/${clusterID}/s3/identities`, { headers: authHeaders() });
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    return r.json() as Promise<{
      identities: { name: string; credentials?: { accessKey: string; secretKey: string }[]; actions?: string[] }[];
      raw: string;
      parse_error?: string;
    }>;
  },
  s3UpsertIdentity: (clusterID: string, b: { user: string; access_key?: string; secret_key?: string; actions?: string[] }) =>
    jpost(`${BASE}/clusters/${clusterID}/s3/identities`, b, "PUT") as Promise<{ output: string }>,
  s3DeleteIdentity: (clusterID: string, user: string) =>
    jpost(`${BASE}/clusters/${clusterID}/s3/identities/${encodeURIComponent(user)}`, undefined, "DELETE") as Promise<{ output: string }>,
  s3IdentityRotation: async (clusterID: string, thresholdDays = 180) => {
    const r = await fetch(`${BASE}/clusters/${clusterID}/s3/identities/rotation?threshold=${thresholdDays}`, { headers: authHeaders() });
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    return r.json() as Promise<IdentityRotationResp>;
  },
  s3BucketDelete: (clusterID: string, name: string) =>
    jpost(`${BASE}/clusters/${clusterID}/s3/bucket/delete`, { name }) as Promise<{ output: string }>,
  s3BucketOwner: (clusterID: string, b: { bucket: string; owner: string }) =>
    jpost(`${BASE}/clusters/${clusterID}/s3/bucket/owner`, b) as Promise<{ output: string }>,
  s3BucketQuota: (clusterID: string, b: { name: string; size_mb?: number; disable?: boolean }) =>
    jpost(`${BASE}/clusters/${clusterID}/s3/bucket/quota`, b) as Promise<{ output: string }>,
  s3BucketQuotaEnforce: (clusterID: string, b: { name: string; enforce: boolean }) =>
    jpost(`${BASE}/clusters/${clusterID}/s3/bucket/quota-enforce`, b) as Promise<{ output: string }>,
  s3CircuitBreaker: (clusterID: string, b: { action: string; type?: string; value?: string }) =>
    jpost(`${BASE}/clusters/${clusterID}/s3/circuit-breaker`, b) as Promise<{ output: string }>,
  s3CleanUploads: (clusterID: string, time_ago: string) =>
    jpost(`${BASE}/clusters/${clusterID}/s3/clean-uploads`, { time_ago }) as Promise<{ output: string }>,
  // Structured multipart upload introspection — read-only filer walk.
  // Used by both the Clean Uploads UI (smart classifier) and the
  // list_clean_uploads AI tool.
  s3ListMultipartUploads: async (clusterID: string, opts?: { older_than_hours?: number; bucket?: string }) => {
    const p = new URLSearchParams();
    if (opts?.older_than_hours != null) p.set("older_than_hours", String(opts.older_than_hours));
    if (opts?.bucket) p.set("bucket", opts.bucket);
    const r = await fetch(`${BASE}/clusters/${clusterID}/s3/multipart-uploads?${p.toString()}`, { headers: authHeaders() });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
    return r.json() as Promise<{ items: MultipartUpload[]; truncated: boolean }>;
  },
  s3AbortMultipartUpload: async (clusterID: string, bucket: string, uploadID: string) => {
    const r = await fetch(
      `${BASE}/clusters/${clusterID}/s3/multipart-uploads/${encodeURIComponent(bucket)}/${encodeURIComponent(uploadID)}`,
      { method: "DELETE", headers: authHeaders() }
    );
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
    return r.json() as Promise<{ ok: boolean; bucket: string; upload_id: string }>;
  },
  s3NLPolicy: (clusterID: string, body: { prompt: string; scope_hint?: string }) =>
    jpost(`${BASE}/clusters/${clusterID}/s3/nl-policy`, body) as Promise<{
      ok: boolean;
      proposal_id?: string;
      proposal?: { actions: string[]; buckets: string[]; explanation: string; risk: "low" | "medium" | "high" };
      warnings?: string[];
      error?: string;
      raw?: string;
    }>,
  // Record the operator's verdict on a proposal — drives the S3 panel
  // on the AI Learning page. Sent right after Approve (with applied data)
  // or Discard (with no applied data).
  s3NLPolicyDecide: (proposalID: string, body: {
    decision: "approved" | "discarded" | "edited";
    applied_actions?: string[];
    applied_buckets?: string[];
    applied_user?: string;
  }) => jpost(`${BASE}/ai/s3-proposals/${proposalID}/decide`, body) as Promise<{ ok: boolean }>,

  // Circuit-breaker AI recommender. POST (no body) → AI inspects the
  // current `s3.circuitBreaker -list` output and returns a single
  // (type, value) proposal with a risk badge and reasoning. The
  // operator applies via the existing s3CircuitBreaker handler and
  // records the decision via s3LimitProposalDecide.
  s3RecommendLimits: (clusterID: string) =>
    jpost(`${BASE}/clusters/${clusterID}/s3/recommend-limits`, {}) as Promise<{
      ok: boolean;
      proposal_id?: string;
      proposal?: { type: "Count" | "MB"; value: number; risk: "low" | "medium" | "high"; explanation: string };
      warnings?: string[];
      snapshot?: { circuit_breaker_raw?: string; cluster_shape?: Record<string, unknown> };
      error?: string;
      raw?: string;
    }>,
  s3LimitProposalDecide: (proposalID: string, body: {
    decision: "approved" | "discarded" | "edited";
    applied_type?: "Count" | "MB";
    applied_value?: number;
  }) => jpost(`${BASE}/ai/s3-limit-proposals/${proposalID}/decide`, body) as Promise<{ ok: boolean }>,
  upsertCluster:(b: unknown) => jpost(`${BASE}/clusters`, b, "PUT"),
  deleteCluster:(id: string) => jpost(`${BASE}/clusters/${id}`, undefined, "DELETE"),
  runClusterShell:(id: string, b: { command: string; args?: string; reason?: string }) =>
                 jpost(`${BASE}/clusters/${id}/shell`, b),
  upsertTag:    (cid: string, b: unknown) => jpost(`${BASE}/clusters/${cid}/tags`, b, "PUT"),
  deleteTag:    (id: string) => jpost(`${BASE}/tags/${id}`, undefined, "DELETE"),
  setConfig:    (key: string, b: { value: unknown; expected_version: number; note?: string }) =>
                 jpost(`${BASE}/config/${encodeURIComponent(key)}`, b, "PUT"),
  rollbackConfig: (key: string, hid: number) =>
                 jpost(`${BASE}/config/${encodeURIComponent(key)}/rollback/${hid}`),
  upsertBackend: (b: unknown) => jpost(`${BASE}/backends`, b, "PUT"),
  deleteBackend: (id: string) => jpost(`${BASE}/backends/${id}`, undefined, "DELETE"),
  testBackend:   (id: string) => jpost(`${BASE}/backends/${id}/test`),
  upsertMonitorTarget: (b: unknown) => jpost(`${BASE}/monitor/targets`, b, "PUT"),
  deleteMonitorTarget: (id: string) => jpost(`${BASE}/monitor/targets/${id}`, undefined, "DELETE"),
  upsertAlertChannel: (b: unknown) => jpost(`${BASE}/alerts/channels`, b, "PUT"),
  deleteAlertChannel: (id: string) => jpost(`${BASE}/alerts/channels/${id}`, undefined, "DELETE"),
  upsertAlertRule:    (b: unknown) => jpost(`${BASE}/alerts/rules`,    b, "PUT"),
  deleteAlertRule:    (id: string) => jpost(`${BASE}/alerts/rules/${id}`,    undefined, "DELETE"),
  testAlert:          (b: unknown) => jpost(`${BASE}/alerts/test`, b),
  upsertAlertTemplate:(b: unknown) => jpost(`${BASE}/alerts/templates`, b, "PUT"),
  deleteAlertTemplate:(id: string) => jpost(`${BASE}/alerts/templates/${id}`, undefined, "DELETE"),
  previewAlertTemplate:(b: { title_tmpl: string; body_tmpl: string; vars?: Record<string, unknown> }) =>
                       jpost(`${BASE}/alerts/templates/preview`, b),
  upsertAnalyzerScript:(b: Partial<AnalyzerScript>, reason?: string) =>
                       jpost(`${BASE}/analyzer/scripts${reason ? `?reason=${encodeURIComponent(reason)}` : ""}`, b, "PUT"),
  deleteAnalyzerScript:(id: string) => jpost(`${BASE}/analyzer/scripts/${id}`, undefined, "DELETE"),
  runAnalyzerScript:(b: { id?: string; body?: string; input?: string; params?: Record<string, unknown>; ephemeral?: boolean }) =>
                    jpost(`${BASE}/analyzer/run`, b) as Promise<AnalyzerRunResult>,
  optimizeAnalyzerScript:(id: string, b: { focus?: string; sample_input?: string }) =>
                    jpost(`${BASE}/analyzer/scripts/${id}/optimize`, b) as Promise<{
                      ok: boolean;
                      body?: string;
                      rationale?: string;
                      sandbox_result?: AnalyzerRunResult;
                      error?: string;
                      raw?: string;
                    }>,
  revertAnalyzerScript:(id: string, version: number) =>
                    jpost(`${BASE}/analyzer/scripts/${id}/revert/${version}`),
  emergencyStop:    (engaged: boolean, note: string) => jpost(`${BASE}/safety/emergency-stop`, { engaged, note }),
  upsertBlocklist:  (b: unknown) => jpost(`${BASE}/safety/blocklist`,  b, "PUT"),
  deleteBlocklist:  (id: string) => jpost(`${BASE}/safety/blocklist/${id}`,  undefined, "DELETE"),
  upsertMaintenance:(b: unknown) => jpost(`${BASE}/safety/maintenance`, b, "PUT"),
  deleteMaintenance:(id: string) => jpost(`${BASE}/safety/maintenance/${id}`, undefined, "DELETE"),
  upsertSkill:      (b: unknown) => jpost(`${BASE}/skills`, b, "PUT"),
  toggleSkill:      (key: string, enabled: boolean) =>
                     jpost(`${BASE}/skills/${encodeURIComponent(key)}/toggle`, { enabled }),
  validateSkill:    (def: unknown) => jpost(`${BASE}/skills/validate`, def),
  draftSkillFromText: (body: { text: string; hint_category?: string; hint_risk?: string }) =>
                     jpost(`${BASE}/skills/draft-from-text`, body),
  refreshAnalytics: () => jpost(`${BASE}/analytics/refresh`),
  upsertAIProvider: (b: unknown) => jpost(`${BASE}/ai/providers`, b, "PUT"),
  deleteAIProvider: (id: string) => jpost(`${BASE}/ai/providers/${id}`, undefined, "DELETE"),
  testAIProvider:   (id: string) => jpost(`${BASE}/ai/providers/${id}/test`),
  runTaskReview:    (taskId: string) => jpost(`${BASE}/tasks/${taskId}/review`),
  upsertOpsTemplate: (b: Partial<OpsTemplate> & { name: string; steps: OpsStep[] }) =>
                     jpost(`${BASE}/ops/templates`, b, "PUT"),
  deleteOpsTemplate: (id: string) => jpost(`${BASE}/ops/templates/${id}`, undefined, "DELETE"),
  draftOpsTemplate:  (text: string, lang?: string) =>
                     jpost(`${BASE}/ops/templates/draft`, { text, lang }) as Promise<{
                       ok: boolean; mode: "json" | "ai"; draft?: OpsTemplate; error?: string; raw?: string;
                     }>,
  precheckOpsStep:   (body: {
                       command: string;
                       rendered_args: string;
                       reason?: string;
                       template_goal?: string;
                       prior_output?: string;
                     }) => jpost(`${BASE}/ops/templates/precheck-step`, body) as Promise<OpsPrecheckResponse>,

  // --- Drain jobs ---
  createDrain: (clusterID: string, body: { node: string; force?: boolean; reason?: string }) =>
    jpost(`${BASE}/clusters/${clusterID}/drains`, body) as Promise<{ id: string }>,
  cancelDrain: (id: string) => jpost(`${BASE}/drains/${id}/cancel`),

  // --- Create Task from AI proposal ---
  createTaskFromProposal: (body: {
    cluster_id: string;
    title?: string;
    collection?: string;
    from_backend?: string;
    to_backend: string;
    task_command?: string;
    rationale?: string;
    monthly_saving?: number;
    currency?: string;
    risk?: string;
    confidence?: string;
    bytes?: number;
    volume_id?: number;
  }) => jpost(`${BASE}/tasks/from-proposal`, body) as Promise<{ id: string; status: string }>,

  // --- Policy simulation ---
  // asOf (RFC3339) opts into time-machine mode — dry-run against the
  // historical feature snapshot nearest that instant instead of live state.
  simulatePolicy: (policyID: string, clusterID: string, asOf?: string) =>
    jpost(`${BASE}/policies/${policyID}/simulate?cluster_id=${clusterID}${
      asOf ? `&as_of=${encodeURIComponent(asOf)}` : ""
    }`) as Promise<PolicySimResp>,

  // --- Bucket governance ---
  upsertBucketGovernance: (clusterID: string, bucket: string, body: {
    owner_name: string; owner_user_key: string; retention_days: number | null; notes: string;
  }) => jpost(
    `${BASE}/clusters/${clusterID}/buckets/${encodeURIComponent(bucket)}/governance`,
    body, "PUT",
  ),
  scanBucketLifecycle: (clusterID: string, bucket: string) =>
    jpost(`${BASE}/clusters/${clusterID}/buckets/${encodeURIComponent(bucket)}/lifecycle-scan`) as Promise<{
      ok: boolean; expired_objects: number; expired_bytes: number;
      truncated: boolean; sample?: string[]; error?: string;
    }>,

  // --- Capacity incidents ---
  analyzeIncident: (id: string) =>
    jpost(`${BASE}/incidents/${id}/analyze`) as Promise<{
      ok: boolean; report?: IncidentReport; error?: string; raw?: string;
    }>,
  resolveIncident: (id: string) => jpost(`${BASE}/incidents/${id}/resolve`),

  // --- Path-scoped migration wizard ---
  pathMigratePreview: (clusterID: string, body: {
    path: string;
    recursive?: boolean;
    glob?: string;
    min_size_bytes?: number;
    min_age_days?: number;
  }) => jpost(`${BASE}/clusters/${clusterID}/path-migrate/preview`, body) as Promise<PathPreviewResponse>,
  pathMigrateAIPlan: (clusterID: string, body: {
    path: string;
    recursive?: boolean;
    glob?: string;
    min_size_bytes?: number;
    min_age_days?: number;
    target_backend?: string;
    extra_context?: string;
    max_proposals?: number;
  }) => jpost(`${BASE}/clusters/${clusterID}/path-migrate/ai-plan`, body) as Promise<{
    ok: boolean;
    path?: string;
    preview?: PathPreviewResponse;
    proposals?: AIMigrationProposal[];
    summary?: string;
    total_saving?: number;
    currency?: string;
    error?: string;
    raw?: string;
  }>,

  // --- Costs / pricing ---
  upsertPricing: (b: Partial<BackendPricing>) =>
    jpost(`${BASE}/pricing`, b, "PUT") as Promise<BackendPricing>,
  deletePricing: (id: string) => jpost(`${BASE}/pricing/${id}`, undefined, "DELETE"),
  snapshotCosts: (clusterID: string) =>
    jpost(`${BASE}/costs/snapshot?cluster_id=${clusterID}`),
  aiPlanMigrations: (clusterID: string, body?: { max_proposals?: number; extra_context?: string }) =>
    jpost(`${BASE}/costs/ai-plan?cluster_id=${clusterID}`, body || {}) as Promise<{
      ok: boolean;
      proposals?: AIMigrationProposal[];
      summary?: string;
      total_saving?: number;
      currency?: string;
      error?: string;
      raw?: string;
    }>,
};
