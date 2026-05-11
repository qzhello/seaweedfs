// Parse Skill-engine execution logs into structured step records.
//
// Log format produced by internal/executor/skill_engine.go:
//   » skill=<key> v<N> risk=<level>
//   → step[<i>] <name> (op=<op>)
//     <indented op-specific lines…>
//     ↺ attempt <a>/<m> failed: <err>; sleeping <dur>
//     ✓ <name> in <duration>            ← success terminator
//     ✖ <name> failed, <action>: <err>  ← failure terminator
//   » skill complete
//
// Anything outside a step block (e.g. "✖ precondition X failed") is
// captured as banner-level entries.

export interface StepRecord {
  index: number;
  name: string;
  op: string;
  status: "succeeded" | "failed" | "running";
  durationMs: number | null;   // null if running / unparseable
  attempts: number;
  error?: string;
  failureMode?: "abort" | "rollback" | "continue" | undefined;
  detail: string[];            // raw indented lines under the step header
}

export interface Banner {
  kind: "info" | "warn" | "error";
  text: string;
}

export interface ParsedSkillLog {
  skillKey?: string;
  version?: number;
  riskLevel?: string;
  banners: Banner[];
  steps: StepRecord[];
  totalMs: number;             // sum of step durations (rough wall-clock proxy)
  complete: boolean;           // saw the "» skill complete" marker
}

const STEP_START_RE  = /^→\s+step\[(\d+)]\s+(\S+)\s+\(op=(\S+)\)/;
const STEP_OK_RE     = /^\s*✓\s+(\S+)\s+in\s+(\S+)/;
const STEP_FAIL_RE   = /^\s*✖\s+(\S+)\s+failed,\s+(\S+):\s+(.*)$/;
const RETRY_RE       = /^\s*↺\s+attempt\s+(\d+)\/\d+\s+failed:/;
const HEADER_RE      = /^»\s+skill=(\S+)\s+v(\d+)\s+risk=(\S+)/;
const COMPLETE_RE    = /^»\s+skill complete/;
const PRECOND_RE     = /^([✖⚠·])\s+(?:pre|post)check\s+"([^"]+)"\s+(.+)$/;

// parseDurationMs handles "12ms", "1.5s", "1m23s", "2h5m". Returns 0 on miss.
export function parseDurationMs(s: string): number {
  s = s.trim();
  if (!s) return 0;
  // Compact go-style "1m23s" / "1h2m3s" / "1.5s" / "12ms".
  let total = 0;
  const re = /(-?\d+(?:\.\d+)?)([a-zµ]+)/g;
  let m: RegExpExecArray | null;
  let matched = false;
  while ((m = re.exec(s)) !== null) {
    matched = true;
    const v = Number(m[1]);
    switch (m[2]) {
      case "ns": total += v / 1e6; break;
      case "us": case "µs": total += v / 1e3; break;
      case "ms": total += v; break;
      case "s":  total += v * 1000; break;
      case "m":  total += v * 60_000; break;
      case "h":  total += v * 3_600_000; break;
      default: break;
    }
  }
  return matched ? Math.round(total) : 0;
}

// parseSkillLog parses the structured log. Pass executionRunning=true while
// polling a live execution so the open step (no terminator yet) stays as
// "running" instead of being flipped to "failed" — otherwise the UI shows
// a misleading red X for whatever step is currently in flight.
export function parseSkillLog(raw: string | undefined | null, executionRunning: boolean = false): ParsedSkillLog {
  const out: ParsedSkillLog = {
    banners: [], steps: [], totalMs: 0, complete: false,
  };
  if (!raw) return out;

  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  let cur: StepRecord | null = null;

  // Internal step terminators (✓ / ✖) flush; only the trailing flush at
  // end-of-parse needs to distinguish "execution still running" from
  // "execution finished but step missing terminator".
  const flush = (atEnd: boolean = false) => {
    if (!cur) return;
    if (cur.status === "running" && atEnd && !executionRunning) {
      // Execution itself has finished and this step never logged ✓ or ✖
      // — treat as failed (engine likely crashed).
      cur.status = "failed";
    }
    // Otherwise: leave status="running" so the UI renders the Clock icon
    // and the operator sees the in-flight step.
    out.steps.push(cur);
    cur = null;
  };

  for (const lineRaw of lines) {
    const line = lineRaw.replace(/\s+$/, "");
    if (!line) continue;

    let m: RegExpMatchArray | null;

    if ((m = line.match(HEADER_RE))) {
      out.skillKey = m[1];
      out.version = Number(m[2]);
      out.riskLevel = m[3];
      continue;
    }
    if (COMPLETE_RE.test(line)) {
      out.complete = true;
      flush();
      continue;
    }
    if ((m = line.match(STEP_START_RE))) {
      flush();
      cur = {
        index: Number(m[1]),
        name: m[2],
        op: m[3],
        status: "running",
        durationMs: null,
        attempts: 1,
        detail: [],
      };
      continue;
    }
    if (cur && (m = line.match(STEP_OK_RE)) && m[1] === cur.name) {
      cur.status = "succeeded";
      cur.durationMs = parseDurationMs(m[2]);
      flush();
      continue;
    }
    if (cur && (m = line.match(STEP_FAIL_RE)) && m[1] === cur.name) {
      cur.status = "failed";
      cur.failureMode = m[2] as StepRecord["failureMode"];
      cur.error = m[3];
      flush();
      continue;
    }
    if (cur && (m = line.match(RETRY_RE))) {
      cur.attempts = Math.max(cur.attempts, Number(m[1]) + 1);
      cur.detail.push(line.trimStart());
      continue;
    }
    if ((m = line.match(PRECOND_RE))) {
      const sym = m[1];
      const kind: Banner["kind"] = sym === "✖" ? "error" : sym === "⚠" ? "warn" : "info";
      out.banners.push({ kind, text: line.trim() });
      continue;
    }
    if (cur) {
      cur.detail.push(line.trimStart());
    } else {
      out.banners.push({ kind: "info", text: line.trim() });
    }
  }
  flush(true);
  out.totalMs = out.steps.reduce((s, x) => s + (x.durationMs ?? 0), 0);
  return out;
}
