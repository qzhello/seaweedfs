"use client";

import { useState } from "react";
import { Tag, Trash2 } from "lucide-react";
import { api, useClusterTags } from "@/lib/api";
import { useCaps } from "@/lib/caps-context";

const DOMAINS = ["flight", "train", "hotel", "car_rental", "attraction", "logs", "finance", "backup", "other"];
const DTYPES = ["", "metadata", "media", "log", "report", "compliance"];

export function TagEditor({ clusterId }: { clusterId: string }) {
  const { data, mutate } = useClusterTags(clusterId);
  const { me, loading } = useCaps();
  const [form, setForm] = useState({
    cluster_id: clusterId,
    scope_kind: "cluster",
    scope_value: "*",
    business_domain: "other",
    data_type: "",
    holiday_sensitive: false,
    notes: "",
  });
  const canEdit = !loading && me?.role === "admin";

  return (
    <section className="card p-5">
      <h2 className="text-sm font-medium mb-3 flex items-center gap-2"><Tag size={14}/> Tags</h2>
      {canEdit ? (
        <div className="grid grid-cols-7 gap-2 items-end">
          <Field label="Scope">
            <select
              className="input w-full"
              value={form.scope_kind}
              onChange={(e) => setForm({ ...form, scope_kind: e.target.value })}
            >
              <option>cluster</option>
              <option>collection</option>
              <option>bucket</option>
            </select>
          </Field>
          <Field label="Value">
            <input
              className="input w-full"
              value={form.scope_value}
              onChange={(e) => setForm({ ...form, scope_value: e.target.value })}
            />
          </Field>
          <Field label="Domain">
            <select
              className="input w-full"
              value={form.business_domain}
              onChange={(e) => setForm({ ...form, business_domain: e.target.value })}
            >
              {DOMAINS.map((domain) => <option key={domain}>{domain}</option>)}
            </select>
          </Field>
          <Field label="Type">
            <select
              className="input w-full"
              value={form.data_type}
              onChange={(e) => setForm({ ...form, data_type: e.target.value })}
            >
              {DTYPES.map((dtype) => <option key={dtype}>{dtype || "-"}</option>)}
            </select>
          </Field>
          <Field label="Holiday?">
            <input
              type="checkbox"
              className="self-start"
              checked={form.holiday_sensitive}
              onChange={(e) => setForm({ ...form, holiday_sensitive: e.target.checked })}
            />
          </Field>
          <Field label="Notes">
            <input
              className="input w-full"
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
            />
          </Field>
          <button
            className="btn btn-primary"
            onClick={async () => {
              await api.upsertTag(clusterId, { ...form, data_type: form.data_type || null });
              await mutate();
            }}
          >
            Add tag
          </button>
        </div>
      ) : (
        <div className="text-xs text-muted mb-3">You can view tags, but you do not have permission to modify them.</div>
      )}
      <table className="grid mt-3">
        <thead><tr><th>Scope</th><th>Domain</th><th>Type</th><th>Holiday-sensitive</th><th>Notes</th>{canEdit ? <th></th> : null}</tr></thead>
        <tbody>
          {(data?.items || []).map((tag: any) => (
            <tr key={tag.id}>
              <td><span className="badge">{tag.scope_kind}</span> {tag.scope_value}</td>
              <td><span className="badge">{tag.business_domain}</span></td>
              <td>{tag.data_type || "-"}</td>
              <td>{tag.holiday_sensitive ? "yes" : "no"}</td>
              <td className="text-muted text-xs">{tag.notes}</td>
              {canEdit ? (
                <td className="text-right">
                  <button
                    className="btn btn-danger"
                    onClick={async () => {
                      await api.deleteTag(tag.id);
                      await mutate();
                    }}
                  >
                    <Trash2 size={14}/>
                  </button>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="flex flex-col gap-1"><span className="text-xs text-muted">{label}</span>{children}</label>;
}
