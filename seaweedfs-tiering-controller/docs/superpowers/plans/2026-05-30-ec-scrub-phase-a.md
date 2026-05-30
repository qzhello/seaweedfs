# EC 巡检 Phase A — 按需 ec.scrub 端点 + UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An on-demand EC integrity scrub on the EC-shards page: pick a mode (index/local/full), stream `weed shell ec.scrub` progress live, and show a structured summary of broken EC volumes/shards when it finishes.

**Architecture:** A new SSE endpoint `POST /clusters/:id/ec/scrub` (cap `volume.read`, read-only, no Guard) reuses the existing `streamWithHeartbeat` shell-stream helper, tees output to a buffer, and emits a `done` event carrying a parsed broken-summary. A focused `ECScrubPanel` React component reuses the proven fetch-SSE loop (from `ECProgressStream`) but renders a scrub-appropriate view (elapsed + tail + final green/red summary).

**Tech Stack:** Go (gin, SSE), Next.js + React + TypeScript, Tailwind.

---

## Build/Test Environment Note

Local Go is **1.25 via auto-toolchain** (`go build ./...`, `go test ./...`, `gofmt` work). Always `gofmt -l <file>` (no output). Frontend `npm run typecheck` has a PRE-EXISTING RED baseline in unrelated files (`i18n.ts`, `bucket-plan.tsx`, etc.) — acceptance = no NEW errors in the touched file (`cd web && npm run typecheck 2>&1 | grep "<file>"`).

Backend paths relative to `seaweedfs-tiering-controller/`; frontend relative to `seaweedfs-tiering-controller/web/`.

## Verified reuse points

- `streamWithHeartbeat(c *gin.Context, started time.Time, inner func(emit func(string, interface{}), lineSink func(string)))` — `internal/api/ec_ops.go`. Pattern (from `volumeBalanceStream`): set SSE headers, `started := time.Now()`, `ctx, cancel := context.WithTimeout(...)`, `var runErr error`, `var outBuf strings.Builder`, then `streamWithHeartbeat(c, started, func(emit, lineSink){ emit("start", gin.H{...}); sink := func(line string){ outBuf.WriteString(line); outBuf.WriteByte('\n'); lineSink(line) }; _, runErr = d.Sw.RunShellCommandAtWithBin(ctx, cl.MasterAddr, cl.WeedBinPath, "<cmd>", args, sink); emit("done", gin.H{"ok": runErr==nil, "error": errStr, "duration_ms": ..., "summary": ...}) })`, then audit.
- `d.Sw.RunShellCommandAtWithBin(ctx, master, binPath, name string, args []string, sink ShellLineSink) (string, error)`.
- `auth.RequireCap(d.Caps, "volume.read")`; `auth.Of(c) (principal, bool)`; `d.PG.Audit(ctx, email, action, resType, resID string, ctx map[string]any) error`; `d.PG.GetCluster(ctx, uuid) (*store.Cluster, error)`; `store.Cluster.MasterAddr/.WeedBinPath`.
- Frontend `ECProgressStream` (`web/components/ec/progress-stream.tsx`) shows the proven fetch-SSE loop: `fetch(\`${BASE}${url}\`, {method:"POST", headers:{...authHeaders()}, body: JSON.stringify(body), signal})`, then `resp.body.getReader()`, decode, split on `"\n\n"`, parse `event:`/`data:` lines, dispatch `start`/`line`/`done`/`ping`. `authHeaders, BASE` exported from `@/lib/api`.
- EC shards page `web/app/clusters/[id]/ec-shards/page.tsx`: client component, `useClusterDetail()` → `{id}`, `useCaps()` → `{has}`, header + table. (After the instant-UI work it renders header always + a `loadingData` skeleton for the table.)

---

## Task 1: Backend pure functions — `parseECScrubOutput` + `validateScrubMode` (TDD)

**Files:**
- Create: `internal/api/cluster_ec_scrub.go`
- Create: `internal/api/cluster_ec_scrub_test.go`

- [ ] **Step 1: Write the failing test** — `internal/api/cluster_ec_scrub_test.go`:

```go
package api

import (
	"reflect"
	"testing"
)

func TestValidateScrubMode(t *testing.T) {
	cases := []struct {
		in      string
		want    string
		wantErr bool
	}{
		{in: "", want: "local"},
		{in: "local", want: "local"},
		{in: "INDEX", want: "index"},
		{in: "Full", want: "full"},
		{in: "deep", wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.in, func(t *testing.T) {
			got, err := validateScrubMode(tc.in)
			if (err != nil) != tc.wantErr {
				t.Fatalf("validateScrubMode(%q) err=%v wantErr=%v", tc.in, err, tc.wantErr)
			}
			if !tc.wantErr && got != tc.want {
				t.Fatalf("validateScrubMode(%q)=%q want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestParseECScrubOutput(t *testing.T) {
	t.Run("no failures", func(t *testing.T) {
		out := "using LOCAL mode\nScrubbing 10.0.0.1:8080 (1/2)...\nScrubbing 10.0.0.2:8080 (2/2)...\nScrubbed 1234 EC files and 7 volumes on 2 nodes\n"
		got := parseECScrubOutput(out)
		if got.BrokenVolumes != 0 || got.BrokenShards != 0 {
			t.Fatalf("expected zero broken, got %+v", got)
		}
		if len(got.AffectedVolumes) != 0 || len(got.AffectedShards) != 0 {
			t.Fatalf("expected empty lists, got %+v", got)
		}
	})

	t.Run("with failures", func(t *testing.T) {
		out := "Scrubbed 10 EC files and 3 volumes on 2 nodes\n" +
			"\nGot scrub failures on 2 EC volumes and 3 EC shards :(\n" +
			"Affected volumes: 10.0.0.1:8080:7, 10.0.0.2:8080:9\n" +
			"Affected shards:  10.0.0.1:8080:7:3, 10.0.0.1:8080:7:5, 10.0.0.2:8080:9:1\n" +
			"Details:\n\t[10.0.0.1:8080] crc mismatch shard 3\n"
		got := parseECScrubOutput(out)
		if got.BrokenVolumes != 2 || got.BrokenShards != 3 {
			t.Fatalf("counts = %d/%d, want 2/3", got.BrokenVolumes, got.BrokenShards)
		}
		wantVols := []string{"10.0.0.1:8080:7", "10.0.0.2:8080:9"}
		if !reflect.DeepEqual(got.AffectedVolumes, wantVols) {
			t.Fatalf("affected volumes = %v, want %v", got.AffectedVolumes, wantVols)
		}
		wantShards := []string{"10.0.0.1:8080:7:3", "10.0.0.1:8080:7:5", "10.0.0.2:8080:9:1"}
		if !reflect.DeepEqual(got.AffectedShards, wantShards) {
			t.Fatalf("affected shards = %v, want %v", got.AffectedShards, wantShards)
		}
	})

	t.Run("empty", func(t *testing.T) {
		got := parseECScrubOutput("")
		if got.BrokenVolumes != 0 || len(got.AffectedShards) != 0 {
			t.Fatalf("expected zero/empty for empty input, got %+v", got)
		}
	})
}
```

- [ ] **Step 2: Run to verify it fails**

`go test ./internal/api/ -run "TestValidateScrubMode|TestParseECScrubOutput" -v`
Expected: FAIL — `undefined: validateScrubMode` / `undefined: parseECScrubOutput` / `undefined: ecScrubSummary`.

- [ ] **Step 3: Implement — `internal/api/cluster_ec_scrub.go`**

```go
package api

import (
	"fmt"
	"regexp"
	"strings"
)

// ecScrubSummary is the parsed broken-shard verdict from an ec.scrub run.
type ecScrubSummary struct {
	BrokenVolumes   int      `json:"broken_volumes"`
	BrokenShards    int      `json:"broken_shards"`
	AffectedVolumes []string `json:"affected_volumes"`
	AffectedShards  []string `json:"affected_shards"`
}

// validateScrubMode normalizes the scrub mode. Empty → "local" (the command
// default). Returns an error for anything outside index/local/full.
func validateScrubMode(mode string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case "":
		return "local", nil
	case "index":
		return "index", nil
	case "local":
		return "local", nil
	case "full":
		return "full", nil
	default:
		return "", fmt.Errorf("invalid scrub mode %q (want index|local|full)", mode)
	}
}

var (
	scrubFailRe   = regexp.MustCompile(`Got scrub failures on (\d+) EC volumes and (\d+) EC shards`)
	scrubVolsRe   = regexp.MustCompile(`(?m)^Affected volumes:\s*(.+)$`)
	scrubShardsRe = regexp.MustCompile(`(?m)^Affected shards:\s*(.+)$`)
)

// parseECScrubOutput extracts the broken summary from the scrub command's
// trailing report. No "Got scrub failures" line → zero broken, empty lists.
func parseECScrubOutput(raw string) ecScrubSummary {
	var s ecScrubSummary
	if m := scrubFailRe.FindStringSubmatch(raw); m != nil {
		fmt.Sscanf(m[1], "%d", &s.BrokenVolumes)
		fmt.Sscanf(m[2], "%d", &s.BrokenShards)
	}
	if m := scrubVolsRe.FindStringSubmatch(raw); m != nil {
		s.AffectedVolumes = splitScrubList(m[1])
	}
	if m := scrubShardsRe.FindStringSubmatch(raw); m != nil {
		s.AffectedShards = splitScrubList(m[1])
	}
	return s
}

// splitScrubList splits a comma-separated affected list, trimming each item
// and dropping blanks. Returns nil (not []) when nothing remains.
func splitScrubList(s string) []string {
	var out []string
	for _, part := range strings.Split(s, ",") {
		if p := strings.TrimSpace(part); p != "" {
			out = append(out, p)
		}
	}
	return out
}
```

- [ ] **Step 4: Run to verify it passes**

`go test ./internal/api/ -run "TestValidateScrubMode|TestParseECScrubOutput" -v` → PASS.
`gofmt -l internal/api/cluster_ec_scrub.go internal/api/cluster_ec_scrub_test.go` → no output.

- [ ] **Step 5: Commit**

```bash
git add internal/api/cluster_ec_scrub.go internal/api/cluster_ec_scrub_test.go
git commit -m "feat(api): ec.scrub output parser + mode validation (pure fns)"
```

---

## Task 2: Backend SSE handler + route

**Files:**
- Modify: `internal/api/cluster_ec_scrub.go` (append)
- Modify: `internal/api/server.go`

- [ ] **Step 1: Append imports + handler to `cluster_ec_scrub.go`**

Add to the existing import block: `"context"`, `"time"`, `"github.com/gin-gonic/gin"`, `"github.com/google/uuid"`, and `"github.com/seaweedfs/seaweedfs-tiering-controller/internal/auth"`. (Keep `fmt`, `regexp`, `strings`.) Then append:

```go
// ecScrubStream runs `weed shell ec.scrub` across the whole cluster and
// streams progress as SSE. The final `done` event carries the parsed
// broken-volumes/shards summary. Read-only (cap volume.read); not gated by
// the safety Guard. ec.scrub holds the cluster shell lock while it runs.
//
// POST /api/v1/clusters/:id/ec/scrub   body: {"mode":"index|local|full"}
func ecScrubStream(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(400, gin.H{"error": "bad cluster id"})
			return
		}
		var body struct {
			Mode string `json:"mode"`
		}
		_ = c.ShouldBindJSON(&body)
		mode, err := validateScrubMode(body.Mode)
		if err != nil {
			c.JSON(400, gin.H{"error": err.Error()})
			return
		}
		cl, err := d.PG.GetCluster(c.Request.Context(), id)
		if err != nil {
			c.JSON(404, gin.H{"error": err.Error()})
			return
		}
		args := []string{"-mode=" + mode}

		c.Writer.Header().Set("Content-Type", "text/event-stream")
		c.Writer.Header().Set("Cache-Control", "no-cache")
		c.Writer.Header().Set("Connection", "keep-alive")
		c.Writer.Header().Set("X-Accel-Buffering", "no")
		started := time.Now()

		// Full-mode scrub reads every EC file's contents — can take a long
		// time on a big cluster. Give it a generous ceiling.
		ctx, cancel := context.WithTimeout(c.Request.Context(), 2*time.Hour)
		defer cancel()

		var runErr error
		var outBuf strings.Builder
		streamWithHeartbeat(c, started, func(emit func(string, interface{}), lineSink func(string)) {
			emit("start", gin.H{
				"args":       args,
				"command":    "ec.scrub",
				"mode":       mode,
				"started_at": started.UnixMilli(),
			})
			sink := func(line string) {
				outBuf.WriteString(line)
				outBuf.WriteByte('\n')
				lineSink(line)
			}
			_, runErr = d.Sw.RunShellCommandAtWithBin(ctx, cl.MasterAddr, cl.WeedBinPath,
				"ec.scrub", args, sink)

			summary := parseECScrubOutput(outBuf.String())
			errStr := ""
			if runErr != nil {
				errStr = runErr.Error()
			}
			emit("done", gin.H{
				"ok":          runErr == nil,
				"error":       errStr,
				"duration_ms": time.Since(started).Milliseconds(),
				"summary":     summary,
			})
		})

		summary := parseECScrubOutput(outBuf.String())
		errStr := ""
		if runErr != nil {
			errStr = runErr.Error()
		}
		p, _ := auth.Of(c)
		_ = d.PG.Audit(c.Request.Context(), p.Email, "ec.scrub", "cluster", id.String(), map[string]any{
			"mode":            mode,
			"ok":              runErr == nil,
			"broken_volumes":  summary.BrokenVolumes,
			"broken_shards":   summary.BrokenShards,
			"error":           errStr,
		})
	}
}
```

- [ ] **Step 2: Register the route in `server.go`**

In `internal/api/server.go`, in the EC routes block (near `/clusters/:id/ec/encode`, `/clusters/:id/ec/balance`, etc.), add:

```go
		// On-demand EC integrity scrub (read-only). Streams per-node
		// progress; the done event carries the broken-shard summary.
		v1.POST("/clusters/:id/ec/scrub",
			auth.RequireCap(d.Caps, "volume.read"), ecScrubStream(d))
```

- [ ] **Step 3: Build, vet, test, format**

```bash
go build ./... 2>&1 | head
go vet ./internal/api/ 2>&1 | head
go test ./internal/api/ -run "TestValidateScrubMode|TestParseECScrubOutput" -v
gofmt -l internal/api/cluster_ec_scrub.go internal/api/server.go
```
Expected: build clean, vet clean, test PASS, gofmt no output. If `go build` reports a signature mismatch (e.g. `streamWithHeartbeat`/`RunShellCommandAtWithBin`/`Audit`/`GetCluster`), fix to match real code — keep structure. Report any adaptation.

- [ ] **Step 4: Commit**

```bash
git add internal/api/cluster_ec_scrub.go internal/api/server.go
git commit -m "feat(api): POST /clusters/:id/ec/scrub SSE handler + route"
```

---

## Task 3: Frontend — `ECScrubPanel` component + API types

**Files:**
- Modify: `web/lib/api.ts`
- Create: `web/components/ec/scrub-panel.tsx`

- [ ] **Step 1: Add types to `web/lib/api.ts`**

```ts
export interface ECScrubSummary {
  broken_volumes: number;
  broken_shards: number;
  affected_volumes: string[];
  affected_shards: string[];
}
```
(No new `api` method needed — the panel opens the SSE stream itself with `fetch` + `authHeaders`/`BASE`, same as `ECProgressStream`.)

- [ ] **Step 2: Create `web/components/ec/scrub-panel.tsx`**

A focused SSE consumer for scrub: elapsed timer + live tail + final green/red summary. Reuses the proven fetch-SSE loop from `progress-stream.tsx` (no shard-progress parsing — scrub is node-by-node, not shard-by-shard).

```tsx
"use client";

// Live panel for an on-demand EC scrub (POST + text/event-stream).
// Renders an elapsed timer, a rolling stdout tail, and — on the `done`
// event — a structured green/red summary of broken EC volumes/shards.
// Unlike ECProgressStream this does NOT parse per-shard progress: ec.scrub
// reports per-node ("Scrubbing addr (i/N)"), so we just tail + summarize.

import { useEffect, useRef, useState } from "react";
import { authHeaders, BASE, type ECScrubSummary } from "@/lib/api";
import { Loader2, AlertTriangle, CheckCircle2, ShieldCheck } from "lucide-react";
import { useT } from "@/lib/i18n";

interface Props {
  clusterID: string;
  mode: string;
  onClose: () => void;
}

export function ECScrubPanel({ clusterID, mode, onClose }: Props) {
  const { t } = useT();
  const [lines, setLines] = useState<string[]>([]);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [finishedAt, setFinishedAt] = useState<number | null>(null);
  const [ok, setOk] = useState<boolean | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [summary, setSummary] = useState<ECScrubSummary | null>(null);
  const [now, setNow] = useState<number>(0);
  const abortRef = useRef<AbortController | null>(null);
  const tailRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (finishedAt) return;
    const i = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(i);
  }, [finishedAt]);

  useEffect(() => {
    const el = tailRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  useEffect(() => {
    const ac = new AbortController();
    abortRef.current = ac;
    (async () => {
      try {
        const resp = await fetch(`${BASE}/clusters/${clusterID}/ec/scrub`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify({ mode }),
          signal: ac.signal,
        });
        if (!resp.ok || !resp.body) {
          const txt = await resp.text().catch(() => "");
          setErr(`${resp.status} ${txt || resp.statusText}`);
          setOk(false);
          setFinishedAt(Date.now());
          return;
        }
        const reader = resp.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            handleEvent(buf.slice(0, idx));
            buf = buf.slice(idx + 2);
          }
        }
      } catch (e) {
        if (!ac.signal.aborted) {
          setErr(e instanceof Error ? e.message : String(e));
          setOk(false);
          setFinishedAt(Date.now());
        }
      }
    })();
    return () => { ac.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterID, mode]);

  function handleEvent(raw: string) {
    let event = "message";
    const dataLines: string[] = [];
    for (const ln of raw.split("\n")) {
      if (ln.startsWith("event: ")) event = ln.slice(7).trim();
      else if (ln.startsWith("data: ")) dataLines.push(ln.slice(6));
    }
    const data = dataLines.join("\n");
    if (event === "start") {
      try {
        const obj = JSON.parse(data) as { started_at?: number };
        setStartedAt(obj.started_at || Date.now());
      } catch { setStartedAt(Date.now()); }
    } else if (event === "line") {
      setLines(prev => {
        const next = prev.length > 800 ? prev.slice(-700) : prev.slice();
        next.push(data);
        return next;
      });
    } else if (event === "done") {
      setFinishedAt(Date.now());
      try {
        const obj = JSON.parse(data) as { ok?: boolean; error?: string; summary?: ECScrubSummary };
        setOk(!!obj.ok);
        if (obj.error) setErr(obj.error);
        if (obj.summary) setSummary(obj.summary);
      } catch { setOk(true); }
    }
    // ping events: ignore (heartbeat).
  }

  const elapsedMs = startedAt ? (finishedAt || now || Date.now()) - startedAt : 0;
  const elapsedS = Math.floor(elapsedMs / 1000);
  const running = !finishedAt;
  const cancel = () => { abortRef.current?.abort(); onClose(); };

  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold inline-flex items-center gap-2">
          {running ? <Loader2 size={14} className="animate-spin text-accent"/>
            : ok ? <CheckCircle2 size={14} className="text-success"/>
            : <AlertTriangle size={14} className="text-danger"/>}
          {t("EC scrub")} · {mode}
        </h3>
        <div className="flex items-center gap-3">
          <span className="text-xs font-mono text-muted">{elapsedS}s</span>
          <button className="btn" onClick={cancel}>{running ? t("Cancel") : t("Close")}</button>
        </div>
      </div>

      {finishedAt && summary && (
        summary.broken_volumes === 0 && summary.broken_shards === 0 ? (
          <div className="text-xs text-success inline-flex items-center gap-2">
            <ShieldCheck size={14}/> {t("All EC shards intact")}
          </div>
        ) : (
          <div className="rounded border border-danger/40 bg-danger/10 p-3 space-y-2 text-xs">
            <div className="text-danger inline-flex items-center gap-2 font-medium">
              <AlertTriangle size={14}/>
              {summary.broken_volumes} {t("broken EC volumes")} · {summary.broken_shards} {t("broken shards")}
            </div>
            {summary.affected_volumes.length > 0 && (
              <div><span className="text-muted">{t("Affected volumes")}: </span>
                <span className="font-mono break-all">{summary.affected_volumes.join(", ")}</span></div>
            )}
            {summary.affected_shards.length > 0 && (
              <div><span className="text-muted">{t("Affected shards")}: </span>
                <span className="font-mono break-all">{summary.affected_shards.join(", ")}</span></div>
            )}
          </div>
        )
      )}

      {err && <div className="text-xs text-danger inline-flex items-center gap-2"><AlertTriangle size={14}/> {err}</div>}

      <pre ref={tailRef} className="font-mono text-[10px] p-2 rounded bg-bg border border-border overflow-auto max-h-[28vh] whitespace-pre-wrap">
        {lines.length === 0 ? t("(waiting for output…)") : lines.join("\n")}
      </pre>
    </div>
  );
}
```

- [ ] **Step 3: Verify + commit**

```bash
cd web && npm run typecheck 2>&1 | grep -E "lib/api.ts|scrub-panel.tsx"   # expect no output
git add web/lib/api.ts web/components/ec/scrub-panel.tsx
git commit -m "feat(web): ECScrubSummary type + ECScrubPanel SSE component"
```

---

## Task 4: Wire the scrub card into the EC-shards page

**Files:**
- Modify: `web/app/clusters/[id]/ec-shards/page.tsx`

- [ ] **Step 1: Read the file**

Confirm: `useClusterDetail()` → `{id}`, `useCaps()` → `{has}`, `useT()`, the early returns and the main `return (<div className="space-y-5"> <header>…</header> {table/skeleton} </div>)`. Confirm `has("volume.read")` is the page's read gate (the page is already only reachable with volume.read).

- [ ] **Step 2: Imports + state**

- Add `import { ECScrubPanel } from "@/components/ec/scrub-panel";`.
- Inside the component, add:
```tsx
  const [scrubMode, setScrubMode] = useState("local");
  const [scrubKey, setScrubKey] = useState<number | null>(null); // null = no run; number = active run key
```
(Use the existing `useState` import; it's already imported on this page.)

- [ ] **Step 3: Render the scrub card**

Immediately AFTER the `<header>…</header>` (and before the table/skeleton), add:
```tsx
      <section className="card p-4 space-y-3">
        <header className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h3 className="text-sm font-semibold inline-flex items-center gap-2">
              <ShieldCheck size={14}/> {t("EC integrity scrub")}
            </h3>
            <p className="text-xs text-muted">
              {t("Actively read and verify EC shard contents to catch silent corruption. Holds the cluster shell lock while running; full mode reads every file and can be slow.")}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <select
              aria-label={t("Scrub mode")}
              value={scrubMode}
              onChange={(e) => setScrubMode(e.target.value)}
              disabled={scrubKey !== null}
              className="input text-xs"
            >
              <option value="index">index — {t("index only (fastest)")}</option>
              <option value="local">local — {t("needle data (default)")}</option>
              <option value="full">full — {t("deep file contents (slow)")}</option>
            </select>
            <button
              className="btn btn-primary inline-flex items-center gap-1"
              onClick={() => setScrubKey(Date.now())}
              disabled={scrubKey !== null}
            >
              <ShieldCheck size={12}/> {t("Start scrub")}
            </button>
          </div>
        </header>
        {scrubKey !== null && (
          <ECScrubPanel key={scrubKey} clusterID={id} mode={scrubMode} onClose={() => setScrubKey(null)}/>
        )}
      </section>
```
- Add `ShieldCheck` to the page's `lucide-react` import.

Note on `scrubKey`: it doubles as "is a run active" (null = no) and a remount key so each "Start scrub" click mounts a fresh `ECScrubPanel` (re-triggering its `useEffect` stream). `onClose` (Cancel/Close in the panel) sets it back to null, re-enabling the mode select + button.

- [ ] **Step 4: Verify + commit**

```bash
cd web && npm run typecheck 2>&1 | grep "ec-shards/page.tsx"   # expect no output
git add "web/app/clusters/[id]/ec-shards/page.tsx"
git commit -m "feat(web): EC integrity scrub card on ec-shards page"
```

---

## Task 5: i18n keys

**Files:**
- Modify: `web/lib/i18n.ts`

- [ ] **Step 1: Add zh keys (grep each first; skip any already present — quoted OR unquoted form)**

For each key, run `grep -nE '^\s*"?<key>"?\s*:' lib/i18n.ts`; add only if absent (the file has both quoted and unquoted keys — adding a duplicate in either form causes TS1117). Add the absent ones to the zh map:

```
"EC scrub": "EC 巡检",
"EC integrity scrub": "EC 完整性巡检",
"Start scrub": "开始巡检",
"Scrub mode": "巡检模式",
"index only (fastest)": "仅索引(最快)",
"needle data (default)": "needle 数据(默认)",
"deep file contents (slow)": "深度文件内容(慢)",
"All EC shards intact": "所有 EC 分片完好",
"broken EC volumes": "损坏 EC 卷",
"broken shards": "损坏分片",
"Affected volumes": "受影响卷",
"Affected shards": "受影响分片",
"Actively read and verify EC shard contents to catch silent corruption. Holds the cluster shell lock while running; full mode reads every file and can be slow.": "主动读取并校验 EC 分片内容以发现静默损坏。运行期间占用集群 shell 锁;full 模式读取每个文件,可能较慢。",
"(waiting for output…)": "(等待输出…)",
```
(`Cancel`, `Close` almost certainly already exist — do NOT re-add. `Affected volumes`/`Affected shards` may exist; grep first.)

- [ ] **Step 2: Verify + commit**

```bash
cd web && npm run typecheck 2>&1 | grep "lib/i18n.ts"   # no NEW errors naming your keys
git add web/lib/i18n.ts
git commit -m "feat(web): zh i18n keys for EC scrub"
```

---

## Final Verification (after all tasks)

- [ ] `go build ./... && go test ./internal/api/ -run "ScrubMode|ScrubOutput" -v` — build clean, tests PASS.
- [ ] `cd web && npm run typecheck 2>&1 | grep -E "api.ts|scrub-panel.tsx|ec-shards/page.tsx|i18n.ts"` — no NEW errors; `npm run build` succeeds.
- [ ] **Manual smoke:** EC-shards page → pick mode `index` → Start scrub → live tail streams per-node lines → on finish, green "All EC shards intact" (or red broken summary with affected lists). Mode select + button disabled during a run; Cancel aborts and re-enables. Try `full` mode (slower). Without `volume.read` the page isn't reachable (no extra gating needed).
- [ ] Dispatch a final whole-feature reviewer; then use superpowers:finishing-a-development-branch. Note: Phase B (scheduled scrub + persistence + alerting) is a separate spec to brainstorm next.
