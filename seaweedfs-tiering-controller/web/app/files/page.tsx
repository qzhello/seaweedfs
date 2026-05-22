"use client";

// File Browser — operator-facing view of the filer's namespace. Lets
// you navigate directories, inspect entry metadata (collection, disk
// type, mtime, size), upload / download files, and create / delete
// entries. Useful before a tiering decision: see what's actually in
// the path before crafting a policy or move plan.
//
// Backend already proxies to filer with JWT auth; we just render what
// it returns. SeaweedFS directories are implicit — mkdir creates a
// `.keep` placeholder so the empty folder is visible.

import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  FolderTree, Folder, FileIcon, ChevronRight, Home, RefreshCw, Upload,
  FolderPlus, Trash2, Download, Loader2, X, AlertTriangle, Snowflake,
} from "lucide-react";
import { api, useClusterFiles, type FilerEntry } from "@/lib/api";
import { useCluster } from "@/lib/cluster-context";
import { useT } from "@/lib/i18n";
import { Can } from "@/components/can";
import { ErrorPanel } from "@/components/error-panel";
import { RefreshButton } from "@/components/refresh-button";
import { TableSkeleton } from "@/components/table-skeleton";
import { EmptyState } from "@/components/empty-state";
import { toast } from "@/lib/toast";

export default function FilesPage() {
  const { t } = useT();
  return (
    <Can cap="file.read" fallback={
      <div className="card p-6 text-sm text-muted">{t("You don't have permission to view this page.")}</div>
    }>
      <Inner/>
    </Can>
  );
}

const PATH_KEY = "tier.files.lastPath";

function Inner() {
  const { t } = useT();
  const { clusterID } = useCluster();
  const [path, setPath] = useState<string>("/");

  // Restore the last visited path from localStorage on mount. The
  // ?path=… query string wins if present (deep link).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const q = new URLSearchParams(window.location.search).get("path");
    if (q && q.startsWith("/")) { setPath(q); return; }
    try {
      const v = localStorage.getItem(PATH_KEY);
      if (v && v.startsWith("/")) setPath(v);
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reflect current path to the URL so the back button does the
  // intuitive thing (navigate one directory up).
  useEffect(() => {
    if (typeof window === "undefined") return;
    try { localStorage.setItem(PATH_KEY, path); } catch { /* ignore */ }
    const url = new URL(window.location.href);
    if (url.searchParams.get("path") !== path) {
      url.searchParams.set("path", path);
      window.history.replaceState({}, "", url.toString());
    }
  }, [path]);

  const { data, error, mutate, isLoading, isValidating } = useClusterFiles(clusterID || undefined, path);

  const entries: FilerEntry[] = data?.listing?.Entries ?? [];
  const sorted = useMemo(() => {
    // Directories first, then files; both alphabetical. Operators
    // expect this from every desktop file manager.
    return [...entries].sort((a, b) => {
      const ad = isDir(a) ? 0 : 1;
      const bd = isDir(b) ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return baseName(a.FullPath).localeCompare(baseName(b.FullPath));
    });
  }, [entries]);

  if (!clusterID) {
    return (
      <div className="space-y-4">
        <Header t={t}/>
        <div className="card p-6 text-sm text-muted">
          {t("Pick a cluster in the top-right to start.")}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Header t={t}/>

      <Toolbar
        t={t}
        filer={data?.filer}
        clusterID={clusterID}
        path={path}
        validating={isValidating}
        onRefresh={() => mutate()}
        onNavigate={setPath}
      />

      <Breadcrumb path={path} onNavigate={setPath} t={t}/>

      {error && <ErrorPanel error={error}/>}

      {isLoading && !data ? (
        <section className="card overflow-hidden">
          <TableSkeleton rows={8} headers={[t("Name"), t("Size"), t("Modified"), t("Mime"), ""]}/>
        </section>
      ) : sorted.length === 0 ? (
        <DropZone clusterID={clusterID} path={path} filer={data?.filer} onUploaded={() => mutate()} t={t}>
          <EmptyState
            icon={FolderTree}
            title={t("Empty directory")}
            hint={t("Drop files here to upload, or use the Upload button above.")}
          />
        </DropZone>
      ) : (
        <DropZone clusterID={clusterID} path={path} filer={data?.filer} onUploaded={() => mutate()} t={t}>
          <section className="card overflow-hidden">
            <table className="grid">
              <thead>
                <tr>
                  <th>{t("Name")}</th>
                  <th className="text-right">{t("Size")}</th>
                  <th>{t("Modified")}</th>
                  <th>{t("Mime")}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((e) => (
                  <EntryRow
                    key={e.FullPath}
                    entry={e}
                    clusterID={clusterID}
                    filer={data?.filer}
                    onNavigate={setPath}
                    onChanged={() => mutate()}
                    t={t}
                  />
                ))}
              </tbody>
            </table>
          </section>
        </DropZone>
      )}

      {data?.listing?.ShouldDisplayLoadMore && (
        <div className="text-xs text-muted">
          {t("More entries available. Open a sub-directory to narrow, or use the filer-side paging directly.")}
        </div>
      )}
    </div>
  );
}

// ---------- bits ----------

function Header({ t }: { t: (k: string) => string }) {
  return (
    <header>
      <h1 className="text-base font-semibold tracking-tight inline-flex items-center gap-2">
        <FolderTree size={20}/> {t("File Browser")}
      </h1>
      <p className="text-xs text-muted mt-1 max-w-2xl">
        {t("Browse the cluster's filer namespace. Use this to inspect what's stored under a path before crafting a tiering policy or move plan.")}
      </p>
    </header>
  );
}

interface ToolbarProps {
  t: (k: string) => string;
  filer?: string;
  clusterID: string;
  path: string;
  validating: boolean;
  onRefresh: () => void;
  onNavigate: (p: string) => void;
}

function Toolbar({ t, filer, clusterID, path, validating, onRefresh, onNavigate }: ToolbarProps) {
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const [creating, setCreating] = useState(false);

  const onMkdir = async () => {
    const name = window.prompt(t("New folder name"));
    if (!name || !name.trim()) return;
    const clean = name.trim().replace(/^\/+|\/+$/g, "");
    if (!clean || clean.includes("/")) {
      toast.warn(t("Folder name cannot be empty or contain '/'"));
      return;
    }
    setCreating(true);
    try {
      const full = (path.endsWith("/") ? path : path + "/") + clean;
      await api.filesMkdir(clusterID, { path: full, filer: filer || "" });
      toast.success(t("Folder created"));
      onRefresh();
    } catch (e) {
      toast.fromError(e, t("Failed to create folder"));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="flex items-center justify-between flex-wrap gap-2">
      <div className="flex items-center gap-2 text-xs text-muted">
        {filer && (
          <span className="badge text-[10px] font-mono">
            filer {filer}
          </span>
        )}
        <button
          onClick={() => onNavigate("/")}
          className="text-muted hover:text-text inline-flex items-center gap-1"
          title={t("Go to root")}
        >
          <Home size={12}/> /
        </button>
      </div>
      <div className="flex items-center gap-2">
        {/* Bulk-tier shortcut: opens the wizard pre-scoped to this
            directory. Read-only — anyone with file.read can preview. */}
        <Link
          href={`/path-migrate?path=${encodeURIComponent(path)}`}
          className="btn inline-flex items-center gap-1.5 text-xs"
          title={t("Open the path-scoped migration wizard for this directory")}
        >
          <Snowflake size={12}/> {t("Tier this folder")}
        </Link>
        <RefreshButton loading={validating} onClick={onRefresh}/>
        <Can cap="file.write">
          <button
            className="btn inline-flex items-center gap-1.5 text-xs"
            disabled={creating}
            onClick={onMkdir}
          >
            {creating ? <Loader2 size={12} className="animate-spin"/> : <FolderPlus size={12}/>}
            {t("New folder")}
          </button>
          <button
            className="btn btn-primary inline-flex items-center gap-1.5 text-xs"
            onClick={() => uploadInputRef.current?.click()}
          >
            <Upload size={12}/> {t("Upload")}
          </button>
          <UploadButton
            ref={uploadInputRef}
            clusterID={clusterID}
            path={path}
            filer={filer}
            onDone={onRefresh}
            t={t}
          />
        </Can>
      </div>
    </div>
  );
}

// UploadButton owns the hidden file input + the multi-file queue. The
// trigger button lives in the Toolbar and forwards a ref to the input;
// we keep the queue state here so uploads survive the Toolbar's
// `creating` re-renders.
interface UploadButtonProps {
  clusterID: string;
  path: string;
  filer?: string;
  onDone: () => void;
  t: (k: string) => string;
}
const UploadButton = forwardRef<HTMLInputElement, UploadButtonProps>(function UploadButton(
  { clusterID, path, filer, onDone, t }, ref,
) {
  const [queue, setQueue] = useState<{ name: string; done: number; total: number; err?: string }[]>([]);

  const upload = async (files: FileList | File[]) => {
    const arr = Array.from(files);
    if (arr.length === 0) return;
    // Seed queue rows so the operator sees every file immediately,
    // not just the first one whose progress event fires.
    setQueue(arr.map(f => ({ name: f.name, done: 0, total: f.size })));
    for (let i = 0; i < arr.length; i++) {
      const f = arr[i];
      try {
        await api.filesUpload(clusterID, filer || "", path, f, (done, total) => {
          setQueue(q => q.map((row, idx) => idx === i ? { ...row, done, total } : row));
        });
        setQueue(q => q.map((row, idx) => idx === i ? { ...row, done: row.total } : row));
      } catch (e) {
        setQueue(q => q.map((row, idx) => idx === i ? { ...row, err: (e as Error).message } : row));
      }
    }
    onDone();
    // Auto-clear successful rows after a short delay so the panel
    // doesn't grow unbounded across sessions.
    setTimeout(() => setQueue(q => q.filter(r => !!r.err)), 3000);
  };

  return (
    <>
      <input
        type="file"
        ref={ref}
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files) {
            upload(e.target.files);
            e.target.value = "";
          }
        }}
      />
      {queue.length > 0 && (
        <div className="fixed bottom-4 right-4 z-40 w-96 card p-3 space-y-1.5 shadow-2xl">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold inline-flex items-center gap-1.5">
              <Upload size={12}/> {t("Uploading")}
            </span>
            <button onClick={() => setQueue([])} className="text-muted hover:text-text" aria-label={t("Close")}>
              <X size={12}/>
            </button>
          </div>
          {queue.map((row, i) => (
            <div key={i} className="space-y-0.5">
              <div className="flex items-center justify-between text-[11px]">
                <span className="truncate">{row.name}</span>
                <span className="text-muted font-mono">
                  {row.err ? <span className="text-rose-300">{t("error")}</span>
                    : row.done >= row.total
                      ? <span className="text-emerald-300">100%</span>
                      : `${Math.round((row.done / Math.max(1, row.total)) * 100)}%`}
                </span>
              </div>
              <div className="h-1 bg-panel2 rounded overflow-hidden">
                <div
                  className={`h-full ${row.err ? "bg-rose-400/60" : "bg-accent"}`}
                  style={{ width: `${Math.round((row.done / Math.max(1, row.total)) * 100)}%` }}
                />
              </div>
              {row.err && <div className="text-[10px] text-rose-300 truncate">{row.err}</div>}
            </div>
          ))}
        </div>
      )}
    </>
  );
});

function Breadcrumb({ path, onNavigate, t }: { path: string; onNavigate: (p: string) => void; t: (k: string) => string }) {
  const parts = path.split("/").filter(Boolean);
  return (
    <nav aria-label={t("Path")} className="flex items-center gap-0.5 text-xs flex-wrap">
      <button
        onClick={() => onNavigate("/")}
        className="text-muted hover:text-text inline-flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-panel2"
      >
        <Home size={12}/> {t("root")}
      </button>
      {parts.map((seg, i) => {
        const sub = "/" + parts.slice(0, i + 1).join("/");
        const isLast = i === parts.length - 1;
        return (
          <span key={sub} className="inline-flex items-center gap-0.5">
            <ChevronRight size={12} className="text-muted/50"/>
            <button
              onClick={() => onNavigate(sub)}
              disabled={isLast}
              className={`px-1.5 py-0.5 rounded font-mono ${
                isLast ? "text-text font-medium" : "text-muted hover:text-text hover:bg-panel2"
              }`}
            >
              {seg}
            </button>
          </span>
        );
      })}
    </nav>
  );
}

interface EntryRowProps {
  entry: FilerEntry;
  clusterID: string;
  filer?: string;
  onNavigate: (p: string) => void;
  onChanged: () => void;
  t: (k: string) => string;
}
function EntryRow({ entry, clusterID, filer, onNavigate, onChanged, t }: EntryRowProps) {
  const [deleting, setDeleting] = useState(false);
  const name = baseName(entry.FullPath);
  const directory = isDir(entry);

  const onDelete = async () => {
    const msg = directory
      ? t("Delete folder \"{name}\" and ALL its contents?").replace("{name}", name)
      : t("Delete \"{name}\"?").replace("{name}", name);
    if (!window.confirm(msg)) return;
    setDeleting(true);
    try {
      await api.filesDelete(clusterID, filer || "", entry.FullPath, directory);
      toast.success(t("Deleted"));
      onChanged();
    } catch (e) {
      toast.fromError(e, t("Delete failed"));
    } finally {
      setDeleting(false);
    }
  };

  // The existing api.filesDownload handles auth + blob synthesis under
  // the hood — no need to re-implement it here.
  const onDownload = () => {
    api.filesDownload(clusterID, filer || "", entry.FullPath)
      .catch(e => toast.fromError(e, t("Download failed")));
  };

  return (
    <tr className={directory ? "cursor-pointer hover:bg-panel2/40" : ""}>
      <td>
        <button
          onClick={() => directory && onNavigate(entry.FullPath)}
          className="inline-flex items-center gap-2 text-left disabled:cursor-default"
          disabled={!directory}
        >
          {directory
            ? <Folder size={14} className="text-amber-300 shrink-0"/>
            : <FileIcon size={14} className="text-muted shrink-0"/>}
          <span className={`text-sm ${directory ? "font-medium" : ""} truncate max-w-[420px]`}>{name}</span>
        </button>
      </td>
      <td className="text-right font-mono text-xs text-muted">
        {directory ? "—" : humanSize(entry.FileSize ?? 0)}
      </td>
      <td className="text-xs text-muted">{relTime(entry.Mtime, t)}</td>
      <td className="text-xs text-muted">{entry.Mime || <span className="text-muted/60">—</span>}</td>
      <td>
        <div className="flex gap-1 justify-end">
          {directory && (
            // Path-scoped migration wizard — opens with the directory
            // path pre-filled so the operator can run a preview +
            // optional AI plan against just this folder.
            <Link
              href={`/path-migrate?path=${encodeURIComponent(entry.FullPath)}`}
              className="btn text-xs inline-flex items-center"
              title={t("Tier this folder…")}
              onClick={(e) => e.stopPropagation()}
            >
              <Snowflake size={11}/>
            </Link>
          )}
          {!directory && (
            <button onClick={onDownload} className="btn text-xs inline-flex items-center" title={t("Download")}>
              <Download size={11}/>
            </button>
          )}
          <Can cap="file.write">
            <button
              onClick={onDelete}
              disabled={deleting}
              className="btn text-xs inline-flex items-center"
              title={directory ? t("Delete folder") : t("Delete file")}
            >
              {deleting ? <Loader2 size={11} className="animate-spin"/> : <Trash2 size={11}/>}
            </button>
          </Can>
        </div>
      </td>
    </tr>
  );
}

// Reproduce the directory detection from /clusters/[id]/files.
// SeaweedFS filer emits Go's os.FileMode where directories carry
// ModeDir = 1<<31 in the high bit; we also accept the legacy POSIX
// S_IFDIR bit for older filer builds.
const S_IFDIR = 0x4000;
function isDir(entry: FilerEntry): boolean {
  const m = entry.Mode ?? 0;
  return (((m >>> 31) & 1) === 1) || ((m & S_IFDIR) !== 0);
}

// DropZone wraps its children with a full-area drag-and-drop overlay
// that uploads dropped files into the current `path`. It intentionally
// renders the children unchanged when no drag is in progress so the
// layout doesn't shift.
interface DropZoneProps {
  clusterID: string;
  path: string;
  filer?: string;
  onUploaded: () => void;
  t: (k: string) => string;
  children: React.ReactNode;
}
function DropZone({ clusterID, path, filer, onUploaded, t, children }: DropZoneProps) {
  const [dragging, setDragging] = useState(false);
  const counter = useRef(0);

  const onDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    counter.current += 1;
    if (e.dataTransfer.types.includes("Files")) setDragging(true);
  }, []);
  const onDragLeave = useCallback(() => {
    counter.current -= 1;
    if (counter.current <= 0) { counter.current = 0; setDragging(false); }
  }, []);
  const onDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    counter.current = 0; setDragging(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    let okCount = 0;
    let errCount = 0;
    for (const f of files) {
      try {
        await api.filesUpload(clusterID, filer || "", path, f);
        okCount++;
      } catch {
        errCount++;
      }
    }
    if (okCount) toast.success(t("Uploaded {n} file(s)").replace("{n}", String(okCount)));
    if (errCount) toast.error(t("Failed to upload {n} file(s)").replace("{n}", String(errCount)));
    onUploaded();
  }, [clusterID, path, filer, onUploaded, t]);

  return (
    <div
      onDragEnter={onDragEnter}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className="relative"
    >
      {children}
      {dragging && (
        <div className="absolute inset-0 z-10 bg-accent/10 border-2 border-dashed border-accent rounded-md flex items-center justify-center pointer-events-none">
          <div className="text-sm font-semibold inline-flex items-center gap-2 text-accent">
            <Upload size={16}/> {t("Drop to upload to {path}").replace("{path}", path)}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- helpers ----------

function baseName(p: string): string {
  if (!p) return "";
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1) || "/";
}

function humanSize(n: number): string {
  if (!n) return "0";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0; let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 && i > 0 ? v.toFixed(2) : v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function relTime(iso: string | undefined, t: (k: string) => string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return t("just now");
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 30 * 86400) return `${Math.floor(diff / 86400)}d`;
  return d.toLocaleDateString();
}
