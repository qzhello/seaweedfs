// Polls the controller's /counts endpoint for "things needing
// attention right now" so the nav can paint live badges. One
// lightweight call replaces the old approach of fetching full task
// lists just to read .length — see internal/api/counts.go.

import useSWR from "swr";

const BASE = process.env.NEXT_PUBLIC_API_BASE || "/api/v1";

interface CountsPayload {
  pending_tasks?: number;
  running_tasks?: number;
  running_executions?: number;
  running_ops_runs?: number;
}

async function fetcher(url: string): Promise<CountsPayload> {
  const r = await fetch(url, { credentials: "include" });
  if (!r.ok) return {};
  return r.json();
}

export interface RunningCounts {
  pendingTasks: number;
  runningTasks: number;
  runningExecutions: number;
  runningOpsRuns: number;
  hasAny: boolean;
}

export function useRunningCounts(): RunningCounts {
  // 8s feels live without hammering the API. Falls back to zeros on
  // network blip — the nav just hides badges until the next poll.
  const { data } = useSWR<CountsPayload>(`${BASE}/counts`, fetcher, {
    refreshInterval: 8_000,
    revalidateOnFocus: false,
  });
  const pendingTasks      = data?.pending_tasks      ?? 0;
  const runningTasks      = data?.running_tasks      ?? 0;
  const runningExecutions = data?.running_executions ?? 0;
  const runningOpsRuns    = data?.running_ops_runs   ?? 0;
  return {
    pendingTasks,
    runningTasks,
    runningExecutions,
    runningOpsRuns,
    hasAny: pendingTasks + runningTasks + runningExecutions + runningOpsRuns > 0,
  };
}
