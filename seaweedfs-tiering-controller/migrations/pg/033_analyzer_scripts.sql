-- ============================================================
-- Migration 033 — Analyzer scripts (deterministic Python analyzers)
--
-- A platform-curated library of Python scripts that post-process
-- shell command output. Operators (and the AI assistant) pick a
-- script by name/tag, feed it the prior step's stdout + params,
-- and get back structured JSON. Replaces ad-hoc AI-only parsing
-- of `volume.list` / `ec.list` / etc. — Python is 100% accurate
-- on counting / sorting / extrema where the LLM often hallucinates.
--
-- Execution model (see internal/analyzer):
--   python3 -I -c <body>            # isolated mode, no user site
--   stdin  = {"input": "<stdout>", "params": {...}}
--   stdout = {"ok": true, "result": ...} OR {"ok": false, "error": "..."}
--   timeout 10s, max output 2 MB, no network, no subprocess
-- ============================================================

CREATE TABLE IF NOT EXISTS analyzer_scripts (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name         TEXT NOT NULL UNIQUE,
    title        TEXT NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    -- Which shell command(s) this script knows how to parse. Empty
    -- array = "generic, works on any text". Used to filter the
    -- picker in the ops-template editor.
    for_commands TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    -- Free-form tags for AI tool selection: ["sort-by-size",
    -- "find-max-node", "filter-collection"]. Index helps assistant
    -- queries.
    tags         TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    -- Declared params. Same shape as ops_templates variables:
    -- [{name, type, required, default, doc, enum?}]
    params       JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- Python source. Convention: read JSON from stdin, write JSON
    -- to stdout. See seed scripts for the boilerplate.
    body         TEXT NOT NULL,
    -- Optional fixtures so the editor's sandbox can run without a
    -- live cluster. Used to populate the test page.
    sample_input TEXT NOT NULL DEFAULT '',
    sample_output JSONB DEFAULT NULL,
    enabled      BOOLEAN NOT NULL DEFAULT TRUE,
    -- 'system' for shipped scripts (locked), 'user' for operator-
    -- authored. system scripts can be edited but the audit log
    -- distinguishes intent.
    origin       TEXT NOT NULL DEFAULT 'user' CHECK (origin IN ('system','user')),
    created_by   TEXT NOT NULL DEFAULT '',
    updated_by   TEXT NOT NULL DEFAULT '',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_analyzer_scripts_tags    ON analyzer_scripts USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_analyzer_scripts_for_cmd ON analyzer_scripts USING GIN(for_commands);

-- Append-only execution log so operators can audit what ran with
-- what input. Truncated by retention job; not the source of truth.
CREATE TABLE IF NOT EXISTS analyzer_runs (
    id          BIGSERIAL PRIMARY KEY,
    script_id   UUID NOT NULL REFERENCES analyzer_scripts(id) ON DELETE CASCADE,
    actor       TEXT NOT NULL DEFAULT '',
    params      JSONB NOT NULL DEFAULT '{}'::jsonb,
    input_hash  TEXT NOT NULL DEFAULT '',
    input_size  INTEGER NOT NULL DEFAULT 0,
    ok          BOOLEAN NOT NULL,
    error       TEXT NOT NULL DEFAULT '',
    output      JSONB DEFAULT NULL,
    elapsed_ms  INTEGER NOT NULL DEFAULT 0,
    at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_analyzer_runs_at  ON analyzer_runs(at DESC);
CREATE INDEX IF NOT EXISTS idx_analyzer_runs_sid ON analyzer_runs(script_id, at DESC);

-- ============================================================
-- Seed scripts — battle-tested for the most common volume.list /
-- ec.list / collection.list queries. All are origin='system' so
-- they're visibly distinct from operator scripts in the UI.
-- ============================================================

-- A reusable Python preamble. NOTE: each seed embeds its own copy
-- because we can't reference a shared block from inside JSONB.

INSERT INTO analyzer_scripts (name, title, description, for_commands, tags, params, body, sample_input, sample_output, origin)
VALUES

-- ---------- 1. Top-N nodes by volume count ----------
('volume.top_nodes_by_count',
 'Top-N volume servers by volume count',
 'Parse `volume.list` output and return the N nodes carrying the most volumes. Useful for finding rebalance source candidates.',
 ARRAY['volume.list'],
 ARRAY['sort-by-count', 'find-max-node', 'rebalance', 'volume.list'],
 '[{"name":"n","type":"int","required":false,"default":5,"doc":"Number of nodes to return (default 5)"}]'::jsonb,
$PYBODY$
import sys, json, re
io = json.load(sys.stdin)
txt = io.get("input", "")
n = int((io.get("params") or {}).get("n") or 5)
# Match the per-volume "id:NNN size:..." lines under each "Data Node X" header.
# volume.list groups like:
#   Data Node 10.0.0.1:8080 hdd(volume:42/100 active:42 ...)
node_re = re.compile(r"Data Node\s+([\w\.\-:]+)\s+")
vol_re  = re.compile(r"\bid:(\d+)\b")
counts = {}
current = None
for line in txt.splitlines():
    m = node_re.search(line)
    if m:
        current = m.group(1)
        counts.setdefault(current, 0)
        continue
    if current and vol_re.search(line):
        counts[current] += 1
ranked = sorted(counts.items(), key=lambda kv: -kv[1])[:n]
print(json.dumps({"ok": True, "result": [{"server": s, "volumes": c} for s,c in ranked]}))
$PYBODY$,
'',
NULL,
'system'),

-- ---------- 2. Bottom-N nodes by volume count ----------
('volume.bottom_nodes_by_count',
 'Bottom-N volume servers by volume count',
 'Parse `volume.list` output and return the N nodes carrying the fewest volumes. Pair with top_nodes_by_count to plan rebalance source→target.',
 ARRAY['volume.list'],
 ARRAY['sort-by-count', 'find-min-node', 'rebalance', 'volume.list'],
 '[{"name":"n","type":"int","required":false,"default":5,"doc":"Number of nodes to return (default 5)"}]'::jsonb,
$PYBODY$
import sys, json, re
io = json.load(sys.stdin)
txt = io.get("input", "")
n = int((io.get("params") or {}).get("n") or 5)
node_re = re.compile(r"Data Node\s+([\w\.\-:]+)\s+")
vol_re  = re.compile(r"\bid:(\d+)\b")
counts = {}
current = None
for line in txt.splitlines():
    m = node_re.search(line)
    if m:
        current = m.group(1)
        counts.setdefault(current, 0)
        continue
    if current and vol_re.search(line):
        counts[current] += 1
ranked = sorted(counts.items(), key=lambda kv: kv[1])[:n]
print(json.dumps({"ok": True, "result": [{"server": s, "volumes": c} for s,c in ranked]}))
$PYBODY$,
'',
NULL,
'system'),

-- ---------- 3. Volumes filtered by collection ----------
('volume.filter_by_collection',
 'List volumes in a specific collection',
 'Parse `volume.list` output and return the volume IDs (plus size/server) for one collection.',
 ARRAY['volume.list'],
 ARRAY['filter-collection', 'volume.list'],
 '[{"name":"collection","type":"string","required":true,"doc":"Collection name to filter by"}]'::jsonb,
$PYBODY$
import sys, json, re
io = json.load(sys.stdin)
txt = io.get("input", "")
target = (io.get("params") or {}).get("collection") or ""
node_re = re.compile(r"Data Node\s+([\w\.\-:]+)\s+")
# Volume lines look like:
#   id:42 size:104857600 collection:logs file_count:31 ...
line_re = re.compile(r"\bid:(\d+).*?\bsize:(\d+).*?\bcollection:(\S+)")
out = []
current_server = None
for ln in txt.splitlines():
    m = node_re.search(ln)
    if m:
        current_server = m.group(1)
        continue
    m = line_re.search(ln)
    if m and m.group(3) == target:
        out.append({"volume_id": int(m.group(1)), "size": int(m.group(2)), "server": current_server})
print(json.dumps({"ok": True, "result": out}))
$PYBODY$,
'',
NULL,
'system'),

-- ---------- 4. Top-N volumes by size ----------
('volume.top_by_size',
 'Top-N largest volumes',
 'Parse `volume.list` and return the N largest volumes (id, size, server, collection).',
 ARRAY['volume.list'],
 ARRAY['sort-by-size', 'find-max-volume', 'volume.list'],
 '[{"name":"n","type":"int","required":false,"default":10,"doc":"Number of volumes to return"}]'::jsonb,
$PYBODY$
import sys, json, re
io = json.load(sys.stdin)
txt = io.get("input", "")
n = int((io.get("params") or {}).get("n") or 10)
node_re = re.compile(r"Data Node\s+([\w\.\-:]+)\s+")
line_re = re.compile(r"\bid:(\d+).*?\bsize:(\d+)(?:.*?\bcollection:(\S+))?")
all_vols = []
current_server = None
for ln in txt.splitlines():
    m = node_re.search(ln)
    if m:
        current_server = m.group(1)
        continue
    m = line_re.search(ln)
    if m:
        all_vols.append({
            "volume_id": int(m.group(1)),
            "size": int(m.group(2)),
            "collection": m.group(3) or "",
            "server": current_server,
        })
all_vols.sort(key=lambda v: -v["size"])
print(json.dumps({"ok": True, "result": all_vols[:n]}))
$PYBODY$,
'',
NULL,
'system'),

-- ---------- 5. Per-rack volume distribution ----------
('volume.by_rack',
 'Volume distribution per rack',
 'Parse `volume.list` and return per-rack (volume_count, total_bytes). Useful for rack imbalance checks.',
 ARRAY['volume.list'],
 ARRAY['by-rack', 'distribution', 'volume.list'],
 '[]'::jsonb,
$PYBODY$
import sys, json, re
io = json.load(sys.stdin)
txt = io.get("input", "")
# Rack header looks like: "Rack r1"; Data Center header: "DataCenter dc1"
rack_re = re.compile(r"^\s*Rack\s+(\S+)")
vol_re  = re.compile(r"\bid:(\d+).*?\bsize:(\d+)")
current_rack = "(none)"
by = {}
for ln in txt.splitlines():
    m = rack_re.match(ln)
    if m:
        current_rack = m.group(1)
        by.setdefault(current_rack, {"volumes": 0, "bytes": 0})
        continue
    m = vol_re.search(ln)
    if m:
        b = by.setdefault(current_rack, {"volumes": 0, "bytes": 0})
        b["volumes"] += 1
        b["bytes"] += int(m.group(2))
out = [{"rack": k, **v} for k,v in sorted(by.items(), key=lambda kv: -kv[1]["volumes"])]
print(json.dumps({"ok": True, "result": out}))
$PYBODY$,
'',
NULL,
'system'),

-- ---------- 6. EC shard distribution health ----------
('ec.shard_health',
 'EC volumes with missing shards',
 'Parse `ec.list` (or `volume.list`-style EC sections) and return any EC volumes where present-shard count is less than the expected 14.',
 ARRAY['ec.list', 'volume.list'],
 ARRAY['ec', 'health-check', 'find-degraded'],
 '[{"name":"min_shards","type":"int","required":false,"default":14,"doc":"Healthy shard floor (default 14 for RS 10+4)"}]'::jsonb,
$PYBODY$
import sys, json, re
io = json.load(sys.stdin)
txt = io.get("input", "")
floor = int((io.get("params") or {}).get("min_shards") or 14)
# Match lines like: "ec_volume_id:42 shards:[0 1 2 3 5 7 ...]"
line_re = re.compile(r"ec_volume_id:(\d+)\s+shards:\[([0-9 ,]+)\]")
out = []
for ln in txt.splitlines():
    m = line_re.search(ln)
    if not m:
        continue
    vid = int(m.group(1))
    shards = [int(x) for x in re.findall(r"\d+", m.group(2))]
    if len(shards) < floor:
        missing = sorted(set(range(14)) - set(shards))
        out.append({"ec_volume_id": vid, "present": shards, "missing": missing, "present_count": len(shards)})
print(json.dumps({"ok": True, "result": out}))
$PYBODY$,
'',
NULL,
'system'),

-- ---------- 7. Read-only volume ratio per node ----------
('volume.readonly_ratio',
 'Read-only volume ratio per server',
 'Compute (read-only count) / (total count) per volume server. High ratios indicate nodes that should be drained or expanded.',
 ARRAY['volume.list'],
 ARRAY['health-check', 'readonly', 'distribution'],
 '[{"name":"min_ratio","type":"int","required":false,"default":50,"doc":"Only return servers with ratio >= this percentage"}]'::jsonb,
$PYBODY$
import sys, json, re
io = json.load(sys.stdin)
txt = io.get("input", "")
min_ratio = int((io.get("params") or {}).get("min_ratio") or 0)
node_re = re.compile(r"Data Node\s+([\w\.\-:]+)\s+")
vol_re  = re.compile(r"\bid:(\d+)\b")
ro_re   = re.compile(r"\breadonly:(\w+)\b|\bread.only\b", re.IGNORECASE)
counts = {}
current = None
for ln in txt.splitlines():
    m = node_re.search(ln)
    if m:
        current = m.group(1)
        counts.setdefault(current, {"total": 0, "ro": 0})
        continue
    if current and vol_re.search(ln):
        counts[current]["total"] += 1
        if ro_re.search(ln):
            counts[current]["ro"] += 1
out = []
for srv, c in counts.items():
    if c["total"] == 0:
        continue
    pct = int(round(100 * c["ro"] / c["total"]))
    if pct >= min_ratio:
        out.append({"server": srv, "total": c["total"], "readonly": c["ro"], "percent": pct})
out.sort(key=lambda r: -r["percent"])
print(json.dumps({"ok": True, "result": out}))
$PYBODY$,
'',
NULL,
'system'),

-- ---------- 8. Generic line-count summary ----------
('text.line_summary',
 'Generic text line summary',
 'Generic fallback: count lines, non-empty lines, longest line. Useful as a smoke-test when authoring new scripts.',
 ARRAY[]::TEXT[],
 ARRAY['generic', 'debug'],
 '[]'::jsonb,
$PYBODY$
import sys, json
io = json.load(sys.stdin)
txt = io.get("input", "")
lines = txt.splitlines()
non_empty = [l for l in lines if l.strip()]
longest = max((len(l) for l in lines), default=0)
print(json.dumps({"ok": True, "result": {
    "lines": len(lines),
    "non_empty_lines": len(non_empty),
    "longest_line_length": longest,
    "first_line": lines[0] if lines else "",
}}))
$PYBODY$,
'',
NULL,
'system')

ON CONFLICT (name) DO NOTHING;
