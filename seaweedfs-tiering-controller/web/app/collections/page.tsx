"use client";

import { useMemo, useState } from "react";
import { Layers, Loader2 } from "lucide-react";
import { useClusters, useCollections, type CollectionRow } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { bytes } from "@/lib/utils";
import { Pagination, usePagination } from "@/components/pagination";
import { RefreshButton } from "@/components/refresh-button";
import { EmptyState } from "@/components/empty-state";
import {
  ShellActionMenu, ShellActionDialog, type ShellAction,
} from "@/components/shell-action";

// One destructive action — deleting a collection removes every volume
// in it. Everything else operators want to do at the collection scope
// (vacuum, balance, tier upload, ec.encode) is already on the catalog
// commands those take `-collection=X`, so we just point operators at
// the Ops Console.
const COLLECTION_ACTIONS: ShellAction<CollectionRow>[] = [
  {
    key: "delete", label: "Delete collection", command: "collection.delete", risk: "destructive",
    buildArgs: (c) => `-collection=${c.name}`,
  },
];

export default function CollectionsPage() {
  const { t } = useT();
  const { data: clustersData } = useClusters();
  const clusters: Array<{ id: string; name: string; master_addr: string; enabled: boolean }> =
    (clustersData?.items ?? []).filter((c: { enabled: boolean }) => c.enabled);

  const [clusterID, setClusterID] = useState<string>("");
  if (!clusterID && clusters.length > 0) setTimeout(() => setClusterID(clusters[0].id), 0);

  const { data, isLoading, isValidating, mutate, error } = useCollections(clusterID || undefined);
  const items = data?.items ?? [];
  const [text, setText] = useState("");

  const filtered = useMemo(() => {
    const q = text.trim().toLowerCase();
    if (!q) return items;
    return items.filter((c) => c.name.toLowerCase().includes(q));
  }, [items, text]);
  const pg = usePagination(filtered, 50);

  const [dialog, setDialog] = useState<{ row: CollectionRow; action: ShellAction<CollectionRow> } | null>(null);

  const totalVols = filtered.reduce((s, c) => s + c.volume_count, 0);
  const totalSize = filtered.reduce((s, c) => s + c.size, 0);

  return (
    <div className="space-y-5">
      <header className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight inline-flex items-center gap-2">
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
          <select
            value={clusterID}
            onChange={(e) => setClusterID(e.target.value)}
            className="bg-panel2 border border-border rounded-md px-3 py-1.5 text-sm"
          >
            <option value="">{t("Select cluster…")}</option>
            {clusters.map((c) => (
              <option key={c.id} value={c.id}>{c.name} — {c.master_addr}</option>
            ))}
          </select>
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
                    <td className="font-mono text-sm">{c.name || <span className="text-muted">(default)</span>}</td>
                    <td className="num">{c.volume_count.toLocaleString()}</td>
                    <td className="num">{bytes(c.size)}</td>
                    <td className="num">{c.file_count.toLocaleString()}</td>
                    <td className="num text-muted">{bytes(c.deleted_bytes)} ({c.delete_count.toLocaleString()})</td>
                    <td>
                      <ShellActionMenu
                        row={c}
                        actions={COLLECTION_ACTIONS}
                        onPick={(a) => setDialog({ row: c, action: a })}
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
    </div>
  );
}
