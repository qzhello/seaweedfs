"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Layers, Loader2 } from "lucide-react";
import { useCollections, useVolumes, type CollectionRow } from "@/lib/api";
import { useCluster } from "@/lib/cluster-context";
import { useT } from "@/lib/i18n";
import { bytes } from "@/lib/utils";
import { Pagination, usePagination } from "@/components/pagination";
import { RefreshButton } from "@/components/refresh-button";
import { EmptyState } from "@/components/empty-state";
import {
  ShellActionMenu, ShellActionDialog, APPLY_INPUT_KEY, type ShellAction,
} from "@/components/shell-action";
import { VolumeBalanceDialog } from "@/components/volume/balance-dialog";

// "balance" is intercepted in onPick and opens the dedicated
// VolumeBalanceDialog (Plan/Apply dual-mode) pre-scoped to the row's
// collection — buildArgs is never invoked for it. "delete" goes through
// the generic ShellActionDialog. Everything else collection-scoped
// (vacuum, tier upload, ec.encode) stays in the Ops Console.
const BALANCE_KEY = "balance";
const COLLECTION_ACTIONS: ShellAction<CollectionRow>[] = [
  {
    key: BALANCE_KEY, label: "Balance volumes (plan / apply)…", command: "volume.balance", risk: "mutate",
    buildArgs: (c) => `-collection=${c.name}`,
  },
  {
    key: "delete", label: "Delete collection", command: "collection.delete", risk: "destructive",
    // Stream: with -apply the master deletes every volume in the
    // collection. The buffered POST stays silent the whole time and the
    // proxy times out → 500. SSE keeps bytes flowing and shows progress.
    stream: true,
    apply: {
      label: "Apply (actually delete this collection)",
      help: "Unchecked = simulation: the shell only prints what would be deleted. Checked appends -apply and permanently removes every volume in the collection.",
    },
    // `_default_` is collection.delete's sentinel for the empty-named
    // (default) collection — an empty -collection= would be rejected.
    buildArgs: (c, input) => {
      const name = c.name || "_default_";
      const apply = (input[APPLY_INPUT_KEY] || "") === "1" ? " -apply" : "";
      return `-collection=${name}${apply}`;
    },
  },
];

export default function CollectionsPage() {
  const { t } = useT();
  const { clusterID } = useCluster();
  const { data, isLoading, isValidating, mutate, error } = useCollections(clusterID || undefined);
  // Volumes power the Balance dialog's collection / DC / rack / node
  // autocomplete and its dry-run move parsing.
  const { data: vd } = useVolumes(clusterID || undefined);
  const allVolumes = vd?.items ?? [];
  const items = data?.items ?? [];
  const [text, setText] = useState("");

  const filtered = useMemo(() => {
    const q = text.trim().toLowerCase();
    if (!q) return items;
    return items.filter((c) => c.name.toLowerCase().includes(q));
  }, [items, text]);
  const pg = usePagination(filtered, 50);

  const [dialog, setDialog] = useState<{ row: CollectionRow; action: ShellAction<CollectionRow> } | null>(null);
  // Separate state for the Balance dialog so it can carry the clicked
  // collection name independently of the generic shell dialog.
  const [balanceCollection, setBalanceCollection] = useState<string | null>(null);

  const totalVols = filtered.reduce((s, c) => s + c.volume_count, 0);
  const totalSize = filtered.reduce((s, c) => s + c.size, 0);

  return (
    <div className="space-y-5">
      <header className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-base font-semibold tracking-tight inline-flex items-center gap-2">
            <Layers size={20}/> {t("Collections")}
          </h1>
          <div className="text-xs text-muted">
            <span className="font-mono text-text">{filtered.length}</span>
            <span> / {items.length}</span>
            <span className="mx-2 text-muted/40">|</span>
            <span>{totalVols} {t("volumes")}</span>
            <span className="mx-2 text-muted/40">|</span>
            <span>{bytes(totalSize)}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <input
            value={text} onChange={(e) => setText(e.target.value)}
            placeholder={t("Search name…")}
            className="input w-60"
          />
          <RefreshButton loading={isValidating} onClick={() => mutate()}/>
        </div>
      </header>

      {error && (
        <div className="card p-4 border-rose-400/40 bg-rose-400/10 text-rose-300 text-xs font-mono whitespace-pre-wrap">
          {String((error as Error).message ?? error)}
        </div>
      )}

      <section className="card overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center text-muted text-sm inline-flex items-center justify-center gap-2 w-full">
            <Loader2 size={14} className="animate-spin"/> {t("Loading…")}
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState icon={Layers} title={items.length === 0 ? t("No collections found") : t("No collections match the filter")}
            hint={clusterID ? t("Collections are created implicitly when files are stored with a -collection tag.") : t("Select a cluster to see its collections.")}/>
        ) : (
          <div className="overflow-x-auto">
            <table className="grid">
              <thead><tr>
                <th>{t("Name")}</th>
                <th className="num">{t("Volumes")}</th>
                <th className="num">{t("Size")}</th>
                <th className="num">{t("Files")}</th>
                <th className="num">{t("Deleted")}</th>
                <th style={{ width: 36 }}></th>
              </tr></thead>
              <tbody>
                {pg.slice.map((c) => (
                  <tr key={c.name}>
                    <td className="font-mono text-sm">
                      {clusterID ? (
                        <Link
                          href={`/clusters/${clusterID}/collections/${encodeURIComponent(c.name || "_default_")}`}
                          className="hover:underline"
                        >
                          {c.name || <span className="text-muted">(default)</span>}
                        </Link>
                      ) : (
                        c.name || <span className="text-muted">(default)</span>
                      )}
                    </td>
                    <td className="num">{c.volume_count.toLocaleString()}</td>
                    <td className="num">{bytes(c.size)}</td>
                    <td className="num">{c.file_count.toLocaleString()}</td>
                    <td className="num text-muted">{bytes(c.deleted_bytes)} ({c.delete_count.toLocaleString()})</td>
                    <td>
                      <ShellActionMenu
                        row={c}
                        actions={COLLECTION_ACTIONS}
                        onPick={(a) => {
                          if (a.key === BALANCE_KEY) {
                            setBalanceCollection(c.name);
                          } else {
                            setDialog({ row: c, action: a });
                          }
                        }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination {...pg}/>
          </div>
        )}
      </section>

      {dialog && clusterID && (
        <ShellActionDialog
          clusterID={clusterID}
          row={dialog.row}
          action={dialog.action}
          onClose={(didRun) => {
            setDialog(null);
            if (didRun) mutate();
          }}
        />
      )}

      {balanceCollection !== null && clusterID && (
        <VolumeBalanceDialog
          clusterID={clusterID}
          allVolumes={allVolumes}
          initialCollection={balanceCollection}
          onClose={() => setBalanceCollection(null)}
          onDone={() => mutate()}
        />
      )}
    </div>
  );
}
