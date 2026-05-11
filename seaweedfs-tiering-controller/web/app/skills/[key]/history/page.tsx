"use client";
import { useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Breadcrumb } from "@/components/breadcrumb";
import { useSkillHistory } from "@/lib/api";

interface HistoryRow {
  version: number;
  definition: object;
  change_note: string;
  changed_by: string;
  changed_at: string;
}

export default function SkillHistoryPage() {
  const { key } = useParams<{ key: string }>();
  const router = useRouter();
  const decoded = decodeURIComponent(key);
  const { data, error } = useSkillHistory(decoded);
  const items: HistoryRow[] = data?.items ?? [];

  // Selected versions for left/right panes. Default: latest vs previous.
  const [leftV, setLeftV] = useState<number | null>(null);
  const [rightV, setRightV] = useState<number | null>(null);

  const left = useMemo(() => items.find(r => r.version === leftV) ?? items[1], [items, leftV]);
  const right = useMemo(() => items.find(r => r.version === rightV) ?? items[0], [items, rightV]);

  if (error) return <div className="card p-5 text-danger">Failed to load history.</div>;
  if (!data)  return <div className="card p-5 text-muted">Loading…</div>;
  if (!items.length) {
    return (
      <div className="space-y-5">
        <Breadcrumb items={[
          { label: "Skills", href: "/skills" },
          { label: decoded, href: `/skills/${encodeURIComponent(decoded)}` },
          { label: "History" },
        ]}/>
        <div className="card p-5 text-muted">No history for {decoded} yet.</div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <Breadcrumb items={[
        { label: "Skills", href: "/skills" },
        { label: decoded, href: `/skills/${encodeURIComponent(decoded)}` },
        { label: "History" },
      ]}/>
      <h1 className="text-2xl font-semibold tracking-tight">
        Version history <span className="font-mono text-base text-accent">{decoded}</span>
      </h1>

      <section className="card p-5">
        <h2 className="text-lg font-medium mb-3">Version list</h2>
        <div className="space-y-1">
          {items.map(h => (
            <div key={h.version} className="flex items-center gap-3 text-sm py-1.5 border-b border-border last:border-0">
              <span className="font-mono text-accent w-12">v{h.version}</span>
              <span className="text-muted text-xs w-44 shrink-0">{new Date(h.changed_at).toLocaleString("zh-CN")}</span>
              <span className="text-muted text-xs w-24 shrink-0">{h.changed_by}</span>
              <span className="flex-1 truncate">{h.change_note || <em className="text-muted">no note</em>}</span>
              <button className="text-xs text-muted hover:text-text" onClick={() => setLeftV(h.version)}>set left</button>
              <button className="text-xs text-muted hover:text-text" onClick={() => setRightV(h.version)}>set right</button>
            </div>
          ))}
        </div>
      </section>

      <section className="grid grid-cols-2 gap-4">
        <DiffPane title={`v${left?.version} (left)`} obj={left?.definition}/>
        <DiffPane title={`v${right?.version} (right)`} obj={right?.definition} compareTo={left?.definition}/>
      </section>
    </div>
  );
}

function DiffPane({ title, obj, compareTo }: { title: string; obj?: object; compareTo?: object }) {
  if (!obj) return <div className="card p-5 text-muted">—</div>;
  const text = JSON.stringify(obj, null, 2);
  const lines = text.split("\n");
  const cmpLines = compareTo ? JSON.stringify(compareTo, null, 2).split("\n") : null;
  const cmpSet = cmpLines ? new Set(cmpLines) : null;

  return (
    <div className="card p-5">
      <div className="text-sm font-medium mb-2">{title}</div>
      <pre className="font-mono text-[11px] whitespace-pre-wrap bg-bg p-3 rounded border border-border max-h-[600px] overflow-auto">
        {lines.map((ln, i) => {
          const changed = cmpSet && !cmpSet.has(ln);
          return (
            <div key={i} className={changed ? "bg-success/15 -mx-3 px-3" : ""}>
              {ln}
            </div>
          );
        })}
      </pre>
    </div>
  );
}
