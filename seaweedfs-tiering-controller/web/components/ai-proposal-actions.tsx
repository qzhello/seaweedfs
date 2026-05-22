"use client";

// Shared action row for an AI migration proposal. Renders three
// buttons:
//   1. Create as Task — directly lands a pending Task (cost.write)
//   2. Open in Ops console — manual shell flow
//   3. Save as template — long-form approval flow
//
// Lives outside the Costs / Path-migrate page files so they don't
// duplicate the create-task call site (which now has retry, conflict
// handling, and inline disabled-state logic).

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, Sparkles, ClipboardPlus, CheckCircle2, Loader2 } from "lucide-react";
import { api, type AIMigrationProposal } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";

interface Props {
  clusterID: string;
  proposal: AIMigrationProposal;
}

export function AIProposalActions({ clusterID, proposal }: Props) {
  const { t } = useT();
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<string | null>(null);

  const createTask = async () => {
    setCreating(true);
    try {
      const r = await api.createTaskFromProposal({
        cluster_id: clusterID,
        title: proposal.title,
        collection: proposal.collection,
        from_backend: proposal.from_backend,
        to_backend: proposal.to_backend,
        task_command: proposal.task_command,
        rationale: proposal.rationale,
        monthly_saving: proposal.monthly_saving,
        currency: proposal.currency,
        risk: proposal.risk,
        confidence: proposal.confidence,
        bytes: proposal.bytes,
      });
      setCreated(r.id);
      toast.success(t("Task created"), t("Awaiting approval in the Tasks queue."));
    } catch (e) {
      const msg = (e as Error).message || "";
      if (msg.includes("409") || msg.includes("active task already exists")) {
        toast.warn(t("Duplicate task"), t("An active task already exists for this volume + target."));
      } else {
        toast.fromError(e, t("Create task failed"));
      }
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="flex flex-wrap gap-2">
      {created ? (
        <Link
          href={`/tasks/${created}`}
          className="btn btn-primary text-xs inline-flex items-center gap-1.5"
        >
          <CheckCircle2 size={11}/> {t("Open created task")} →
        </Link>
      ) : (
        <button
          onClick={createTask}
          disabled={creating}
          className="btn btn-primary text-xs inline-flex items-center gap-1.5"
          title={t("Create a pending Task from this proposal. Approval is still required to execute.")}
        >
          {creating ? <Loader2 size={11} className="animate-spin"/> : <ClipboardPlus size={11}/>}
          {t("Create as Task")}
        </button>
      )}
      <Link
        href={`/ops?command=${encodeURIComponent(proposal.task_command)}&cluster=${clusterID}`}
        className="btn text-xs inline-flex items-center gap-1.5"
      >
        <ArrowRight size={11}/> {t("Open in Ops console")}
      </Link>
      <Link
        href={`/ops/templates?from_ai=1&command=${encodeURIComponent(proposal.task_command)}&goal=${encodeURIComponent(proposal.title)}`}
        className="btn text-xs inline-flex items-center gap-1.5"
      >
        <Sparkles size={11}/> {t("Save as template")}
      </Link>
    </div>
  );
}
