import useSWR from "swr";

const BASE = "/api/v1";

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

function authHeaders(): Record<string, string> {
  const t = getToken();
  const h: Record<string, string> = {};
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
export function useSummary()       { return useSWR(`${BASE}/dashboard/summary`, fetcher); }
export function useVolumes(clusterID?: string) {
  const url = clusterID ? `${BASE}/volumes?cluster_id=${encodeURIComponent(clusterID)}` : `${BASE}/volumes`;
  return useSWR(url, fetcher);
}
export function useHeatmap(h = 168){ return useSWR(`${BASE}/volumes/heatmap?hours=${h}`, fetcher); }
export function useTasks(s = "")   { return useSWR(`${BASE}/tasks${s ? `?status=${s}` : ""}`, fetcher); }
export function usePolicies()      { return useSWR(`${BASE}/policies`, fetcher); }
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
export function useAlertChannels() { return useSWR(`${BASE}/alerts/channels`, fetcher); }
export function useAlertRules()    { return useSWR(`${BASE}/alerts/rules`,    fetcher); }
export function useAlertEvents()   { return useSWR(`${BASE}/alerts/events?limit=100`, fetcher); }
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
};
