"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Loader2, Folder, File as FileIcon, ArrowUp, FolderPlus, Upload, Download, Trash2, RefreshCw, ChevronRight, AlertTriangle,
} from "lucide-react";
import {
  api,
  useClusterFiles,
  useClusterFilers,
  type FilerEntry,
} from "@/lib/api";
import { useCaps } from "@/lib/caps-context";
import { useT } from "@/lib/i18n";
import { bytes } from "@/lib/utils";
import { useClusterDetail } from "../_context";

const ROOT = "/";

// SeaweedFS encodes "is directory" in the Unix mode's file-type bits.
// SeaweedFS filer emits Mode as Go's os.FileMode where directories carry
// ModeDir = 1<<31 (0x80000000) in the high bit, NOT the POSIX low bit
// 0x4000. JS bitwise is 32-bit signed so we use `>>> 31` to extract the
// top bit as a plain 0/1 without sign weirdness. We also accept the
// POSIX bit as a fallback in case a future filer build emits raw mode.
// mode against it instead of pattern-matching the name.
const S_IFDIR = 0x4000;

export default function ClusterFilesPage() {
  const { has, loading: capsLoading } = useCaps();
  const { id } = useClusterDetail();
  const { t } = useT();
  const { data: filersData } = useClusterFilers(id);
  const [filer, setFiler] = useState<string>("");
  const [dirPath, setDirPath] = useState<string>(ROOT);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<string>("");
  const fileInput = useRef<HTMLInputElement>(null);

  // Pick the first filer automatically once the list loads — most
  // clusters have one filer and forcing the operator to click a
  // dropdown is friction with no upside.
  //
  // Pick order:
  //   1. master-reported filers (authoritative, definitely reachable)
  //   2. master+config (reachable AND configured)
  //   3. config-only (last resort — likely unreachable since master
  //      didn't see it, but we still try so the operator doesn't get
  //      stuck if the heartbeat is broken)
  useEffect(() => {
    if (filer || !filersData?.filers?.length) return;
    const rows = filersData.filers;
    const pick =
      rows.find((f) => f.source === "master") ||
      rows.find((f) => f.source === "master+config") ||
      rows[0];
    setFiler(pick.address);
  }, [filer, filersData]);

  // When the selected filer is no longer in the merged list (operator
  // just edited cluster.filer_addr, or master heartbeat dropped the
  // entry), drop the stale selection so the picker above can grab a
  // fresh one. Otherwise the file browser would 400 with "filer X is
  // not registered" forever until the user manually refreshes.
  useEffect(() => {
    if (!filer || !filersData?.filers) return;
    const stillValid = filersData.filers.some((f) => f.address === filer);
    if (!stillValid) setFiler("");
  }, [filer, filersData]);

  const { data, isLoading, isValidating, mutate, error } = useClusterFiles(id, dirPath, filer || undefined);
  const entries = data?.listing?.Entries ?? [];

  // Reset the per-page selection whenever we navigate or change filer
  // — keeping stale paths selected is a footgun for bulk delete.
  useEffect(() => { setSelected(new Set()); }, [dirPath, filer]);

  const breadcrumb = useMemo(() => {
    const segments = dirPath.split("/").filter(Boolean);
    const out: { label: string; path: string }[] = [{ label: t("Root"), path: ROOT }];
    let acc = "";
    for (const seg of segments) {
      acc += "/" + seg;
      out.push({ label: seg, path: acc });
    }
    return out;
  }, [dirPath, t]);

  if (capsLoading) return null;
  if (!has("file.read")) {
    return <div className="card p-6 text-sm text-muted">{t("You do not have permission to browse files.")}</div>;
  }

  const canWrite = has("file.write");

  async function handleUpload(files: FileList | null) {
    if (!files || files.length === 0 || !filer) return;
    setErr("");
    try {
      for (const f of Array.from(files)) {
        await api.filesUpload(id, filer, dirPath, f);
      }
      mutate();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function handleMkdir() {
    if (!canWrite || !filer) return;
    const name = window.prompt(t("New folder name"));
    if (!name) return;
    setErr("");
    try {
      const target = (dirPath.endsWith("/") ? dirPath.slice(0, -1) : dirPath) + "/" + name;
      await api.filesMkdir(id, { path: target, filer });
      mutate();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleDeleteSelected() {
    if (!canWrite || !filer || selected.size === 0) return;
    if (!window.confirm(t("Delete {n} item(s)? This cannot be undone.").replace("{n}", String(selected.size)))) return;
    setErr("");
    try {
      for (const p of Array.from(selected)) {
        const entry = entries.find((e) => e.FullPath === p);
        const recursive = entry ? isDir(entry) : false;
        await api.filesDelete(id, filer, p, recursive);
      }
      setSelected(new Set());
      mutate();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleDownload(entry: FilerEntry) {
    setErr("");
    try {
      await api.filesDownload(id, filer, entry.FullPath);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  function toggleRow(entry: FilerEntry) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(entry.FullPath)) next.delete(entry.FullPath);
      else next.add(entry.FullPath);
      return next;
    });
  }

  function toggleAll() {
    if (selected.size === entries.length) setSelected(new Set());
    else setSelected(new Set(entries.map((e) => e.FullPath)));
  }

  const parentPath = (() => {
    if (dirPath === ROOT) return null;
    const parts = dirPath.split("/").filter(Boolean);
    parts.pop();
    return "/" + parts.join("/");
  })();

  return (
    <div className="space-y-4">
      <header className="flex items-end justify-between gap-3 flex-wrap">
        <div className="space-y-2 min-w-0 flex-1">
          <h2 className="text-sm font-semibold tracking-tight inline-flex items-center gap-2">
            <Folder size={16}/> {t("File browser")}
          </h2>
          <nav className="text-xs text-muted flex items-center flex-wrap gap-0.5 font-mono">
            {breadcrumb.map((b, idx) => (
              <span key={b.path} className="inline-flex items-center gap-0.5">
                {idx > 0 && <ChevronRight size={10} className="text-muted/40"/>}
                <button
                  onClick={() => setDirPath(b.path)}
                  className="hover:text-accent hover:underline disabled:text-text disabled:no-underline"
                  disabled={b.path === dirPath}
                >
                  {b.label}
                </button>
              </span>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-2 shrink-0 flex-nowrap">
          <select
            value={filer}
            onChange={(e) => setFiler(e.target.value)}
            className="input text-xs max-w-[260px]"
            title={t("Choose filer")}
          >
            {filersData?.filers?.map((f) => {
              const tag = f.source === "config" ? ` (${t("config-only")})`
                : f.source === "master+config" ? ` (${t("master+config")})`
                : "";
              return (
                <option key={f.address} value={f.address}>{f.address}{tag}</option>
              );
            }) ?? <option value="">{t("No filer")}</option>}
          </select>
          <button onClick={() => mutate()} disabled={isValidating} className="btn inline-flex items-center gap-1">
            <RefreshCw size={12} className={isValidating ? "animate-spin" : ""}/>
            {t("Refresh")}
          </button>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        {parentPath !== null && (
          <button onClick={() => setDirPath(parentPath || ROOT)} className="btn inline-flex items-center gap-1">
            <ArrowUp size={12}/> {t("Up")}
          </button>
        )}
        {canWrite && (
          <>
            <button onClick={() => fileInput.current?.click()} className="btn inline-flex items-center gap-1" disabled={!filer}>
              <Upload size={12}/> {t("Upload…")}
            </button>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => handleUpload(e.target.files)}
            />
            <button onClick={handleMkdir} className="btn inline-flex items-center gap-1" disabled={!filer}>
              <FolderPlus size={12}/> {t("New folder")}
            </button>
            <button
              onClick={handleDeleteSelected}
              disabled={selected.size === 0}
              className="btn inline-flex items-center gap-1 text-danger hover:border-danger/40 disabled:opacity-40"
            >
              <Trash2 size={12}/> {t("Delete")} ({selected.size})
            </button>
          </>
        )}
      </div>

      {err && (
        <div className="card p-3 border-danger/40 bg-danger/10 text-danger text-xs font-mono inline-flex items-start gap-2">
          <AlertTriangle size={14} className="shrink-0 mt-0.5"/>
          <span className="break-all">{err}</span>
        </div>
      )}
      {error && !err && (
        <div className="card p-3 border-danger/40 bg-danger/10 text-danger text-xs font-mono whitespace-pre-wrap">
          {String((error as Error).message ?? error)}
        </div>
      )}

      <section className="card overflow-hidden">
        {isLoading ? (
          <div className="p-6 text-sm text-muted inline-flex items-center gap-2 justify-center w-full">
            <Loader2 size={14} className="animate-spin"/> {t("Loading files…")}
          </div>
        ) : entries.length === 0 ? (
          <div className="p-6 text-sm text-muted text-center">{t("This folder is empty.")}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="grid">
              <thead><tr>
                {canWrite && <th style={{ width: 28 }}>
                  <input
                    type="checkbox"
                    checked={selected.size > 0 && selected.size === entries.length}
                    onChange={toggleAll}
                  />
                </th>}
                <th>{t("Name")}</th>
                <th className="num">{t("Size")}</th>
                <th>{t("MIME")}</th>
                <th>{t("Modified")}</th>
                <th style={{ width: 80 }}></th>
              </tr></thead>
              <tbody>
                {entries.map((e) => (
                  <FileRow
                    key={e.FullPath}
                    entry={e}
                    selected={selected.has(e.FullPath)}
                    canWrite={canWrite}
                    onToggle={() => toggleRow(e)}
                    onOpen={() => setDirPath(e.FullPath)}
                    onDownload={() => handleDownload(e)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function isDir(entry: FilerEntry): boolean {
  const m = entry.Mode ?? 0;
  // Go ModeDir (top bit) OR legacy POSIX S_IFDIR.
  return (((m >>> 31) & 1) === 1) || ((m & S_IFDIR) !== 0);
}

function FileRow({ entry, selected, canWrite, onToggle, onOpen, onDownload }: {
  entry: FilerEntry;
  selected: boolean;
  canWrite: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onDownload: () => void;
}) {
  const { t } = useT();
  const dir = isDir(entry);
  const name = entry.FullPath.split("/").filter(Boolean).pop() || entry.FullPath;
  const mtime = entry.Mtime ? new Date(entry.Mtime).toLocaleString() : "—";
  return (
    <tr className={selected ? "bg-accent/5" : undefined}>
      {canWrite && (
        <td>
          <input type="checkbox" checked={selected} onChange={onToggle} aria-label={t("Select")}/>
        </td>
      )}
      <td>
        {dir ? (
          <button onClick={onOpen} className="inline-flex items-center gap-2 hover:text-accent">
            <Folder size={12} className="text-accent shrink-0"/>
            <span className="font-mono text-sm">{name}/</span>
          </button>
        ) : (
          <span className="inline-flex items-center gap-2">
            <FileIcon size={12} className="text-muted shrink-0"/>
            <span className="font-mono text-sm">{name}</span>
          </span>
        )}
      </td>
      <td className="num text-xs">{dir ? "—" : bytes(entry.FileSize || 0)}</td>
      <td className="text-xs text-muted">{entry.Mime || (dir ? t("folder") : "—")}</td>
      <td className="text-xs text-muted">{mtime}</td>
      <td>
        {!dir && (
          <button onClick={onDownload} className="text-muted hover:text-accent" title={t("Download")}>
            <Download size={12}/>
          </button>
        )}
      </td>
    </tr>
  );
}
