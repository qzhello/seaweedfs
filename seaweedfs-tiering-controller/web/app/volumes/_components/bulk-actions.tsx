"use client";

import { useEffect, useRef } from "react";
import { Wand2, Undo2, MoreHorizontal, Plus, Scale, Trash2, ShieldCheck, type LucideIcon } from "lucide-react";
import { useT } from "@/lib/i18n";
import { type VolumeRowLike } from "@/components/volume-actions";
import type { Volume } from "./types";

// BulkEncodeButton renders a single "Encode to EC" CTA when the
// selection contains volumes that can be encoded. Disabled when the
// selection spans multiple clusters (ec.encode is per-cluster) or
// includes EC rows.
export function BulkEncodeButton({
  selected, allVolumes, onOpen,
}: {
  selected: VolumeRowLike[];
  // Full cluster volume list so we can look up the TRUE replica count
  // for each selected ID — the user may have ticked only one replica
  // row, but the storage preview must still reflect all replicas of
  // that logical volume.
  allVolumes: Volume[];
  onOpen: (s: {
    clusterID: string;
    volumeIds: number[];
    sourceVolumes: { logicalBytes: number; replicaCount: number }[];
    collection?: string;
    volumeIdsByCollection: { collection: string; volumeIds: number[] }[];
  }) => void;
}) {
  const { t } = useT();
  const clusterIDs = new Set(selected.map((v) => (v as { cluster_id?: string }).cluster_id || ""));
  const hasEC = selected.some((v) => (v as { IsEC?: boolean }).IsEC);
  const oneCluster = clusterIDs.size === 1 && [...clusterIDs][0];
  const disabled = !oneCluster || hasEC;
  let hint = "";
  if (clusterIDs.size > 1) hint = t("Pick volumes from a single cluster.");
  else if (hasEC) hint = t("Selection contains EC volumes (already encoded).");

  // The distinct logical volume IDs the operator chose.
  const selectedIDs = [...new Set(selected.map((v) => Number(v.ID)))].sort((a, b) => a - b);

  // Walk the FULL volume list once. We need three things per match:
  //   1) replicaCount + logicalBytes per ID  → SizePreview
  //   2) collection per ID                    → grouped chip display
  //   3) distinct collection count            → auto-fill / mixed flag
  const byID = new Map<number, { logicalBytes: number; replicaCount: number; collection: string }>();
  const idSet = new Set(selectedIDs);
  for (const v of allVolumes) {
    if (v.IsEC) continue;
    if ((v as { cluster_id?: string }).cluster_id !== oneCluster) continue;
    if (!idSet.has(Number(v.ID))) continue;
    const id = Number(v.ID);
    const sz = Number(v.Size) || 0;
    const cur = byID.get(id);
    if (cur) {
      cur.replicaCount += 1;
      cur.logicalBytes = Math.max(cur.logicalBytes, sz);
    } else {
      byID.set(id, { logicalBytes: sz, replicaCount: 1, collection: v.Collection || "" });
    }
  }
  const sourceVolumes = [...byID.values()].map(({ logicalBytes, replicaCount }) => ({
    logicalBytes, replicaCount,
  }));

  // Group volume IDs by their owning collection so the dialog header
  // can render "mybucket: 5, 7, 9 / another: 12". Sorted by collection
  // name for stable display; IDs inside each group are sorted
  // numerically.
  const collectionMap = new Map<string, number[]>();
  for (const [id, info] of byID) {
    const ids = collectionMap.get(info.collection) || [];
    ids.push(id);
    collectionMap.set(info.collection, ids);
  }
  const volumeIdsByCollection = [...collectionMap.entries()]
    .map(([collection, ids]) => ({ collection, volumeIds: ids.sort((a, b) => a - b) }))
    .sort((a, b) => a.collection.localeCompare(b.collection));

  // Auto-fill collection only when the selection is single-collection.
  const autoCollection = volumeIdsByCollection.length === 1
    ? volumeIdsByCollection[0].collection
    : undefined;

  return (
    <button
      className="btn btn-primary inline-flex items-center gap-1"
      disabled={disabled}
      title={hint}
      onClick={() => oneCluster && onOpen({
        clusterID: oneCluster as string,
        volumeIds: selectedIDs,
        sourceVolumes,
        collection: autoCollection,
        volumeIdsByCollection,
      })}>
      <Wand2 size={12}/> {t("Encode to EC")} ({selectedIDs.length})
    </button>
  );
}

// BulkDecodeButton — symmetrical to BulkEncodeButton but for EC →
// normal rollback. Enabled only when the selection is all-EC (mixing
// EC with non-EC rows is ambiguous) and confined to a single cluster.
export function BulkDecodeButton({
  selected, onOpen,
}: {
  selected: VolumeRowLike[];
  onOpen: (s: { clusterID: string; volumeIds: number[] }) => void;
}) {
  const { t } = useT();
  const clusterIDs = new Set(selected.map((v) => (v as { cluster_id?: string }).cluster_id || ""));
  const allEC = selected.every((v) => (v as { IsEC?: boolean }).IsEC);
  const anyEC = selected.some((v) => (v as { IsEC?: boolean }).IsEC);
  const oneCluster = clusterIDs.size === 1 && [...clusterIDs][0];
  // Hide entirely when there's nothing EC in the selection — keeps
  // the bulk bar clean for everyday non-EC workflows.
  if (!anyEC) return null;
  const disabled = !oneCluster || !allEC;
  let hint = "";
  if (clusterIDs.size > 1) hint = t("Pick volumes from a single cluster.");
  else if (!allEC) hint = t("Selection mixes EC and normal volumes.");

  // Dedupe volume IDs — multi-replica EC rows fold to one ec.decode pass.
  const ids = [...new Set(selected.filter(v => (v as { IsEC?: boolean }).IsEC).map((v) => Number(v.ID)))]
    .sort((a, b) => a - b);

  return (
    <button
      className="btn inline-flex items-center gap-1"
      disabled={disabled}
      title={hint}
      onClick={() => oneCluster && onOpen({
        clusterID: oneCluster as string,
        volumeIds: ids,
      })}>
      <Undo2 size={12}/> {t("Decode")} ({ids.length})
    </button>
  );
}

// OperationsMenu is the consolidated entry-point for the four
// cluster-scoped admin ops (Fix replication / Grow / Balance / Delete
// empty volumes). Each used to live on its own page in the sidebar;
// pulling them inline keeps the operator in the volume list when they
// reach for a tool that's about the volume list. Disabled when no
// cluster is picked — every op needs a single master target.
export function OperationsMenu({
  disabled, emptyCount, onPick, open, setOpen,
}: {
  disabled: boolean;
  emptyCount: number;
  onPick: (key: "fix" | "grow" | "balance" | "empty") => void;
  open: boolean;
  setOpen: (v: boolean) => void;
}) {
  const { t } = useT();
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click. The menu lives outside the button's DOM
  // subtree (anchored next to the trigger but logically peer) so a
  // normal blur handler wouldn't catch toolbar-region clicks.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      if (btnRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open, setOpen]);

  const items: { key: "fix" | "grow" | "balance" | "empty"; icon: LucideIcon; label: string; hint: string; tone?: "danger"; badge?: number }[] = [
    { key: "fix",     icon: ShieldCheck, label: t("Fix replication"),  hint: t("Detect and fix under/over/misplaced replicas.") },
    { key: "grow",    icon: Plus,        label: t("Grow"),             hint: t("Pre-allocate new volumes for a collection.") },
    { key: "balance", icon: Scale,       label: t("Balance"),          hint: t("Plan volume redistribution across servers.") },
    { key: "empty",   icon: Trash2,      label: t("Delete empty"),     hint: t("Remove size=0 volume replicas."), tone: "danger", badge: emptyCount },
  ];

  return (
    <div className="relative">
      <button
        ref={btnRef}
        onClick={() => !disabled && setOpen(!open)}
        disabled={disabled}
        className={`btn inline-flex items-center gap-1.5 ${open ? "bg-accent/15 text-accent" : ""}`}
        title={disabled ? t("Pick a cluster in the topbar first.") : t("Cluster operations.")}>
        <MoreHorizontal size={14}/>
        <span>{t("Operations")}</span>
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          className="absolute right-0 top-full mt-1 z-50 w-72 card bg-panel border border-border shadow-soft py-1">
          {items.map(it => {
            const Icon = it.icon;
            const toneText = it.tone === "danger" ? "text-danger" : "text-text";
            return (
              <button
                key={it.key}
                role="menuitem"
                onClick={() => onPick(it.key)}
                className="w-full text-left px-3 py-2 hover:bg-panel2/60 focus-visible:bg-panel2/60 focus-visible:outline-none flex items-start gap-2.5">
                <Icon size={14} className={`shrink-0 mt-0.5 ${toneText}`}/>
                <div className="flex-1 min-w-0">
                  <div className={`text-sm font-medium ${toneText} inline-flex items-center gap-1.5`}>
                    {it.label}
                    {typeof it.badge === "number" && it.badge > 0 && (
                      <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                        it.tone === "danger" ? "bg-danger/15 text-danger" : "bg-accent/15 text-accent"
                      }`}>
                        {it.badge}
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-muted mt-0.5">{it.hint}</div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
