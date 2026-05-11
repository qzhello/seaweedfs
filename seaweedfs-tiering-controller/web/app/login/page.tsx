"use client";
import { useState } from "react";
import { setToken } from "@/lib/api";
import { useRouter } from "next/navigation";
import { KeyRound } from "lucide-react";

export default function LoginPage() {
  const [token, setT] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const router = useRouter();

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="card p-8 w-[420px] space-y-4">
        <div className="flex items-center gap-2">
          <KeyRound size={18} className="text-accent"/>
          <h1 className="text-lg font-semibold tracking-tight">Tiering Console</h1>
        </div>
        <p className="text-xs text-muted">
          Paste your API token. Tokens are issued by an admin in the <span className="kbd">users</span> table.
          First-boot seed is <span className="kbd">dev-admin-token-change-me</span> — change it ASAP.
        </p>
        <input
          autoFocus
          className="input w-full font-mono text-xs"
          placeholder="paste token here"
          value={token}
          onChange={e => setT(e.target.value)}
          onKeyDown={async e => {
            if (e.key === "Enter") await onSubmit();
          }}
        />
        {err && <div className="text-danger text-xs">{err}</div>}
        <button className="btn btn-primary w-full" onClick={onSubmit}>Continue</button>
      </div>
    </div>
  );

  async function onSubmit() {
    setErr(null);
    // Probe a PG-only endpoint so login works even when SeaweedFS isn't reachable.
    const r = await fetch("/api/v1/skills", { headers: { Authorization: `Bearer ${token}` } });
    if (r.status === 401 || r.status === 403) {
      setErr("Token rejected. Check users.api_token.");
      return;
    }
    if (!r.ok) {
      setErr(`Server error: ${r.status}`);
      return;
    }
    setToken(token.trim());
    router.replace("/");
  }
}
