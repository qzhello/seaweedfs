"use client";

// Cluster durability score — one 0-100 number rolled up from two
// independent risk domains:
//   - Quorum (control plane): master raft leader presence + reachability.
//   - Durability (data plane): volume replica / EC shard shortfalls.
//
// The score is deviation-from-intent: a volume deliberately configured for
// a single copy is NOT penalised here (it is surfaced separately as a
// "single-copy" exposure tile). Only shortfalls against the configured
// ReplicaPlacement — sole copies below policy, under-replication, EC shard
// loss — count against the score. That keeps the number meaning "how far
// is the cluster from the state you asked for".

import { CheckCircle2 } from "lucide-react";
import type { ClusterMastersResponse, ReplicationHealthResp } from "@/lib/api";
import { useT } from "@/lib/i18n";

export type HealthGrade = "healthy" | "degraded" | "at_risk" | "critical";

export interface HealthDeduction {
  key: string; // English source string — also the t() key
  n?: number; // substituted into the {n} placeholder
  points: number; // positive; subtracted from 100
  domain: "quorum" | "durability";
}

export interface ClusterHealth {
  score: number; // 0..100
  grade: HealthGrade;
  deductions: HealthDeduction[];
}

// Prevalence-weighted penalty: floors at 20% of weight so any occurrence
// is visible, and reaches the full weight once ~20% of volumes are
// affected. Keeps a handful of bad volumes from tanking a huge cluster
// while still never hiding them.
function prevalencePenalty(count: number, total: number, weight: number): number {
  if (count <= 0) return 0;
  const frac = count / Math.max(1, total);
  return Math.round(Math.min(weight, Math.max(weight * 0.2, frac * weight * 5)));
}

export function computeClusterHealth(
  masters: ClusterMastersResponse | undefined,
  repl: ReplicationHealthResp | undefined,
): ClusterHealth | null {
  if (!masters && !repl) return null;
  const deductions: HealthDeduction[] = [];

  // ---- Quorum (control plane) ----
  if (masters) {
    const leaders = masters.masters.filter((m) => m.is_leader).length;
    const unreachable = masters.masters.filter((m) => !m.reachable).length;
    const c = masters.consistency;
    if (leaders === 0) {
      deductions.push({ key: "No raft leader", points: 45, domain: "quorum" });
    } else if (leaders > 1) {
      deductions.push({ key: "Split-brain: multiple raft leaders", points: 45, domain: "quorum" });
    }
    if (unreachable > 0) {
      deductions.push({
        key: "{n} master(s) unreachable",
        n: unreachable,
        points: Math.min(30, unreachable * 15),
        domain: "quorum",
      });
    }
    if (leaders === 1 && !c.leader_agreement) {
      deductions.push({ key: "Masters disagree on the leader", points: 20, domain: "quorum" });
    }
    if (!c.peer_set_agreement) {
      deductions.push({ key: "Masters disagree on the peer set", points: 8, domain: "quorum" });
    }
  }

  // ---- Durability (data plane) ----
  if (repl) {
    if (repl.sole_copies > 0) {
      deductions.push({
        key: "{n} sole-copy volume(s) below policy",
        n: repl.sole_copies,
        points: prevalencePenalty(repl.sole_copies, repl.normal_volumes, 40),
        domain: "durability",
      });
    }
    if (repl.ec_potentially_short_shards > 0) {
      deductions.push({
        key: "{n} EC volume(s) with too few shards",
        n: repl.ec_potentially_short_shards,
        points: prevalencePenalty(repl.ec_potentially_short_shards, repl.ec_volumes, 30),
        domain: "durability",
      });
    }
    if (repl.under_replicated > 0) {
      deductions.push({
        key: "{n} under-replicated volume(s)",
        n: repl.under_replicated,
        points: prevalencePenalty(repl.under_replicated, repl.normal_volumes, 18),
        domain: "durability",
      });
    }
  }

  const total = deductions.reduce((sum, d) => sum + d.points, 0);
  const score = Math.max(0, Math.min(100, 100 - total));
  const grade: HealthGrade =
    score >= 90 ? "healthy" : score >= 75 ? "degraded" : score >= 50 ? "at_risk" : "critical";
  return { score, grade, deductions };
}

const GRADE_META: Record<HealthGrade, { tone: string; label: string }> = {
  healthy: { tone: "text-success", label: "Healthy" },
  degraded: { tone: "text-warning", label: "Degraded" },
  at_risk: { tone: "text-warning", label: "At risk" },
  critical: { tone: "text-danger", label: "Critical" },
};

function ScoreRing({ score, tone }: { score: number; tone: string }) {
  const r = 52;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - score / 100);
  return (
    <div className="relative w-28 h-28 shrink-0">
      <svg viewBox="0 0 120 120" className="w-28 h-28 -rotate-90">
        <circle cx="60" cy="60" r={r} fill="none" strokeWidth="9" className="stroke-border" />
        <circle
          cx="60"
          cy="60"
          r={r}
          fill="none"
          strokeWidth="9"
          strokeLinecap="round"
          stroke="currentColor"
          className={`${tone} transition-[stroke-dashoffset] duration-700`}
          strokeDasharray={circ}
          strokeDashoffset={offset}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <div className={`text-3xl font-semibold tabular-nums ${tone}`}>{score}</div>
        <div className="text-[10px] text-muted">/ 100</div>
      </div>
    </div>
  );
}

export function HealthOverview({
  masters,
  repl,
}: {
  masters: ClusterMastersResponse | undefined;
  repl: ReplicationHealthResp | undefined;
}) {
  const { t } = useT();
  const health = computeClusterHealth(masters, repl);
  if (!health) {
    return (
      <section className="card p-4 text-sm text-muted">{t("Loading durability score…")}</section>
    );
  }
  const meta = GRADE_META[health.grade];

  return (
    <section className="card p-4 flex flex-col md:flex-row gap-5 md:items-center">
      <div className="flex items-center gap-4">
        <ScoreRing score={health.score} tone={meta.tone} />
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted">
            {t("Cluster durability")}
          </div>
          <div className={`text-lg font-semibold mt-0.5 ${meta.tone}`}>{t(meta.label)}</div>
          <p className="text-[11px] text-muted mt-1 max-w-[190px]">
            {t("Rolled up from raft quorum and volume replication risk.")}
          </p>
        </div>
      </div>

      <div className="flex-1 min-w-0 w-full md:border-l md:border-border md:pl-5">
        {health.deductions.length === 0 ? (
          <div className="inline-flex items-center gap-2 text-sm text-success">
            <CheckCircle2 size={14} /> {t("All durability checks passed.")}
          </div>
        ) : (
          <ul className="space-y-1.5">
            {health.deductions.map((d, i) => (
              <li key={i} className="flex items-center gap-2 text-xs">
                <span
                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                    d.domain === "quorum" ? "bg-accent" : "bg-warning"
                  }`}
                  title={d.domain === "quorum" ? t("Quorum") : t("Durability")}
                />
                <span className="flex-1 min-w-0 truncate">
                  {t(d.key).replace("{n}", String(d.n ?? ""))}
                </span>
                <span className="font-mono text-danger shrink-0">−{d.points}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
