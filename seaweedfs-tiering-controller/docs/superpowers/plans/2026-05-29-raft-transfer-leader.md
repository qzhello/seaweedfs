# `cluster.raft.transferLeader` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dedicated API endpoint and a masters-page button that let an operator gracefully transfer SeaweedFS master raft leadership (auto-select or a specific target) before maintaining the current leader.

**Architecture:** A new POST handler wraps `weed shell cluster.raft.transferLeader`, gated by an emergency-stop-only Guard check (change/maintenance/holiday windows are intentionally NOT enforced — leadership transfer is a maintenance-prep action). The masters diagnostics endpoint is extended to expose the raft membership (id + gRPC address) so the frontend can offer a target dropdown. A new capability `cluster.raft.transfer` gates the route (admin/operator only).

**Tech Stack:** Go (gin, pgx), SeaweedFS gRPC (`master_pb`), Next.js + React + TypeScript + SWR, PostgreSQL migrations.

---

## Build/Test Environment Note

This repo requires **Go 1.25** to build, but the local toolchain is **Go 1.17** (see memory `go-toolchain-gap`). Therefore, for every backend task:

- **Locally**, the implementer runs `gofmt -l <file>` (must print nothing) and the symbol-consistency `grep` checks shown in each task.
- The Go **unit tests** in this plan are written for pure functions and are runnable by anyone with Go 1.25 (`go test ./internal/...`). If the local toolchain cannot run them, record that the test was written and verify it compiles in spirit via review; the user runs `go build ./...` + `go test ./...` to confirm.

Frontend tasks use the repo's pre-existing `tsc` RED baseline. Acceptance = **no NEW errors in the touched file**, checked via:
`npm run typecheck 2>&1 | grep "<file>"` (must show no new errors versus baseline).

All paths below are relative to `seaweedfs-tiering-controller/`.

---

## File Structure

**Create:**
- `internal/api/cluster_raft_transfer.go` — the transfer-leader handler + its pure helpers (`validateTransferTarget`, `buildTransferArgs`).
- `internal/api/cluster_raft_transfer_test.go` — table-driven tests for the pure helpers.
- `internal/safety/guard_test.go` — test for the emergency-stop verdict helper.
- `migrations/pg/051_cluster_raft_transfer_cap.sql` — seeds the `cluster.raft.transfer` capability.

**Modify:**
- `internal/seaweed/client.go` — `MasterRaftServer` gains `Id` + `GrpcAddress`; `FetchMasterRaftServers` captures them.
- `internal/safety/guard.go` — extract `emergencyStopVerdict`; add `AllowEmergencyOnly`.
- `internal/api/guard_gate.go` — add `guardEmergencyAllow`.
- `internal/api/cluster_masters.go` — add `raftServerInfo`, `RaftServers` response field, thread raw reports, `pickRaftServers` helper.
- `internal/api/server.go` — register the new route.
- `web/lib/api.ts` — `RaftServerInfo` type, `raft_servers` field, `api.transferLeader`.
- `web/app/clusters/[id]/masters/page.tsx` — "Raft leadership" card.
- `web/lib/i18n.ts` — zh translation keys.

---

## Task 1: Capture raft server Id + gRPC address in the seaweed client

The transfer command's `-address` flag needs the **raw gRPC** address, but `FetchMasterRaftServers` currently stores the HTTP-converted form and drops the server Id. Add both as new fields without disturbing the existing `Address` (HTTP) field that other callers rely on.

**Files:**
- Modify: `internal/seaweed/client.go:55-59` (struct) and `internal/seaweed/client.go:246-259` (loop body)

- [ ] **Step 1: Add fields to `MasterRaftServer`**

Replace the struct at `internal/seaweed/client.go:55`:

```go
type MasterRaftServer struct {
	Id          string // raft server id (from gRPC ClusterServers[].Id)
	Address     string // HTTP-normalized address, for display/peer matching
	GrpcAddress string // raw gRPC address, required by cluster.raft.transferLeader -address
	Suffrage    string
	IsLeader    bool
}
```

- [ ] **Step 2: Populate the new fields in `FetchMasterRaftServers`**

In the `for _, server := range resp.ClusterServers` loop, replace the `out = append(...)` block so it captures both raw values:

```go
		rawGrpc := strings.TrimSpace(server.Address)
		address := strings.TrimSpace(server.Id)
		if rawGrpc != "" {
			address = grpcToHTTPAddr(rawGrpc)
		}
		out = append(out, MasterRaftServer{
			Id:          strings.TrimSpace(server.Id),
			Address:     address,
			GrpcAddress: rawGrpc,
			Suffrage:    strings.TrimSpace(server.Suffrage),
			IsLeader:    server.IsLeader,
		})
```

- [ ] **Step 3: Verify formatting + symbols**

Run:
```bash
gofmt -l internal/seaweed/client.go
grep -n "GrpcAddress\|Id " internal/seaweed/client.go | head
```
Expected: `gofmt -l` prints nothing; grep shows the new struct fields and assignments.

- [ ] **Step 4: Commit**

```bash
git add internal/seaweed/client.go
git commit -m "feat(seaweed): capture raft server id + grpc address in MasterRaftServer"
```

---

## Task 2: Add `AllowEmergencyOnly` to the safety Guard (TDD)

Leadership transfer must be blocked by emergency stop but allowed during change/maintenance/holiday windows. Extract the emergency verdict into a pure, testable helper and add the new method.

**Files:**
- Create: `internal/safety/guard_test.go`
- Modify: `internal/safety/guard.go:42-47` (Allow step 1) and add new funcs

- [ ] **Step 1: Write the failing test**

Create `internal/safety/guard_test.go`:

```go
package safety

import "testing"

func TestEmergencyStopVerdict(t *testing.T) {
	t.Run("stopped blocks", func(t *testing.T) {
		v := emergencyStopVerdict(true)
		if v.Allowed {
			t.Fatal("expected Allowed=false when emergency stop engaged")
		}
		if v.Code != "emergency_stop" {
			t.Fatalf("expected code emergency_stop, got %q", v.Code)
		}
		if v.Reason == "" {
			t.Fatal("expected a non-empty reason")
		}
	})
	t.Run("not stopped allows", func(t *testing.T) {
		v := emergencyStopVerdict(false)
		if !v.Allowed {
			t.Fatalf("expected Allowed=true, got verdict %+v", v)
		}
	})
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./internal/safety/ -run TestEmergencyStopVerdict -v`
Expected: FAIL — `undefined: emergencyStopVerdict`.

(If local Go is 1.17 and cannot compile the package, note this and proceed; the user runs it under Go 1.25.)

- [ ] **Step 3: Implement the helpers**

In `internal/safety/guard.go`, add these two functions just below the `Verdict` type (after line 29):

```go
// emergencyStopVerdict is the pure decision for the emergency-stop gate,
// extracted so it can be unit-tested without a runtime snapshot.
func emergencyStopVerdict(stopped bool) Verdict {
	if stopped {
		return Verdict{Allowed: false, Code: "emergency_stop",
			Reason: "Emergency stop is engaged. Disable it in Settings → safety.emergency_stop."}
	}
	return Verdict{Allowed: true}
}

// emergencyStopped reads the emergency-stop flag from the config snapshot.
func (g *Guard) emergencyStopped() bool {
	return g.snapshot != nil && g.snapshot.Bool("safety.emergency_stop", false)
}

// AllowEmergencyOnly evaluates ONLY the emergency-stop gate, skipping the
// change-window / maintenance / holiday gates. Use for maintenance-prep
// actions (e.g. raft leadership transfer) that must remain available during
// those windows but still obey a global emergency stop.
func (g *Guard) AllowEmergencyOnly() Verdict {
	return emergencyStopVerdict(g.emergencyStopped())
}
```

- [ ] **Step 4: Refactor `Allow` step 1 to reuse the helper (DRY)**

Replace the emergency-stop block at the top of `Allow` (currently `internal/safety/guard.go:43-47`):

```go
	// 1. Emergency stop
	if v := emergencyStopVerdict(g.emergencyStopped()); !v.Allowed {
		return v
	}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `go test ./internal/safety/ -run TestEmergencyStopVerdict -v`
Expected: PASS (both subtests).
Also run `gofmt -l internal/safety/guard.go internal/safety/guard_test.go` → prints nothing.

- [ ] **Step 6: Commit**

```bash
git add internal/safety/guard.go internal/safety/guard_test.go
git commit -m "feat(safety): add AllowEmergencyOnly gate (emergency stop only)"
```

---

## Task 3: Add `guardEmergencyAllow` API helper

Mirror the existing `guardAllow` (in `internal/api/guard_gate.go`) but call the emergency-only verdict.

**Files:**
- Modify: `internal/api/guard_gate.go` (append a function)

- [ ] **Step 1: Add the helper**

Append to `internal/api/guard_gate.go` (after the existing `guardAllow` function, before the final newline):

```go

// guardEmergencyAllow enforces ONLY the emergency-stop gate before a
// maintenance-prep mutating operation (e.g. raft leadership transfer).
// Unlike guardAllow it intentionally ignores change/maintenance/holiday
// windows, since those are exactly when an operator needs to move
// leadership off a node before working on it. On block it writes HTTP 423
// and returns false.
func guardEmergencyAllow(d Deps, c *gin.Context) bool {
	if d.Guard == nil {
		return true
	}
	v := d.Guard.AllowEmergencyOnly()
	if !v.Allowed {
		c.JSON(http.StatusLocked, gin.H{
			"error":      v.Reason,
			"code":       v.Code,
			"blocked_by": "safety_guard",
		})
		return false
	}
	return true
}
```

- [ ] **Step 2: Verify formatting + symbols**

Run:
```bash
gofmt -l internal/api/guard_gate.go
grep -n "func guardEmergencyAllow\|AllowEmergencyOnly" internal/api/guard_gate.go
```
Expected: `gofmt -l` prints nothing; grep shows the new function and the method call.

- [ ] **Step 3: Commit**

```bash
git add internal/api/guard_gate.go
git commit -m "feat(api): add guardEmergencyAllow helper (emergency-stop-only 423 gate)"
```

---

## Task 4: Expose raft membership (`raft_servers`) from the masters endpoint (TDD)

The frontend target dropdown needs `(id, gRPC address, suffrage, is_leader)`. Thread the raw raft reports up through the masters handler and convert them with a pure, testable picker.

**Files:**
- Modify: `internal/api/cluster_masters.go` — add type, response field, `masterFetchResult` field, capture in `fetchMaster`, wire in `clusterMasters`, add `pickRaftServers`.
- Modify: `internal/api/cluster_masters_test.go` — add a test for `pickRaftServers`.

- [ ] **Step 1: Write the failing test**

Append to `internal/api/cluster_masters_test.go`:

```go
func TestPickRaftServers(t *testing.T) {
	leaderReport := []seaweed.MasterRaftServer{
		{Id: "m1", GrpcAddress: "10.0.0.1:19333", Suffrage: "Voter", IsLeader: true},
		{Id: "m2", GrpcAddress: "10.0.0.2:19333", Suffrage: "Voter", IsLeader: false},
	}
	reports := map[string][]seaweed.MasterRaftServer{
		"10.0.0.1:9333": leaderReport,
		"10.0.0.2:9333": {}, // empty report from a lagging master
	}

	got := pickRaftServers(reports, "10.0.0.1:9333")
	if len(got) != 2 {
		t.Fatalf("expected 2 raft servers, got %d", len(got))
	}
	if got[0].ID != "m1" || got[0].Address != "10.0.0.1:19333" || !got[0].IsLeader {
		t.Fatalf("unexpected leader entry: %+v", got[0])
	}

	t.Run("empty when no reports", func(t *testing.T) {
		out := pickRaftServers(map[string][]seaweed.MasterRaftServer{}, "")
		if out == nil {
			t.Fatal("expected non-nil empty slice, got nil")
		}
		if len(out) != 0 {
			t.Fatalf("expected 0 entries, got %d", len(out))
		}
	})
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./internal/api/ -run TestPickRaftServers -v`
Expected: FAIL — `undefined: pickRaftServers` and `raftServerInfo`.

- [ ] **Step 3: Add the `raftServerInfo` type and response field**

In `internal/api/cluster_masters.go`, add the type just above `clusterMastersResponse` (before line 68):

```go
type raftServerInfo struct {
	ID       string `json:"id"`
	Address  string `json:"address"` // gRPC address — what transferLeader -address expects
	Suffrage string `json:"suffrage"`
	IsLeader bool   `json:"is_leader"`
}
```

Then add a field to `clusterMastersResponse`:

```go
type clusterMastersResponse struct {
	Cluster          *store.Cluster     `json:"cluster"`
	ConfiguredMaster string             `json:"configured_master"`
	Masters          []clusterMasterRow `json:"masters"`
	Consistency      masterConsistency  `json:"consistency"`
	RaftServers      []raftServerInfo   `json:"raft_servers"`
}
```

- [ ] **Step 4: Capture raw reports in `masterFetchResult` + `fetchMaster`**

Add a field to `masterFetchResult`:

```go
type masterFetchResult struct {
	row         clusterMasterRow
	discovery   []string
	raftServers []seaweed.MasterRaftServer
}
```

Declare `var capturedRaft []seaweed.MasterRaftServer` near the top of `fetchMaster` (next to the other `var` declarations around line 195) so it's in scope when raftErr != nil (then it stays nil).

In `fetchMaster`, inside the `if raftErr == nil {` block (around line 243), capture the peers — add this line right after `row.Reachable = true` within that block:

```go
		capturedRaft = append([]seaweed.MasterRaftServer(nil), raftPeers...)
```

…and at the function's `return masterFetchResult{...}` (around line 290), include it:

```go
	return masterFetchResult{
		row:         row,
		discovery:   sortedKeys(discovery),
		raftServers: capturedRaft,
	}
```

- [ ] **Step 5: Implement `pickRaftServers`**

Add this function at the end of `internal/api/cluster_masters.go`:

```go
// pickRaftServers chooses the most authoritative raft membership report and
// converts it to the wire shape. The leader's own report is preferred; if it
// is missing/empty the longest available report wins. Always returns a
// non-nil slice so JSON serializes [] rather than null.
func pickRaftServers(reports map[string][]seaweed.MasterRaftServer, leaderAddr string) []raftServerInfo {
	best := reports[leaderAddr]
	if len(best) == 0 {
		for _, r := range reports {
			if len(r) > len(best) {
				best = r
			}
		}
	}
	out := make([]raftServerInfo, 0, len(best))
	for _, s := range best {
		out = append(out, raftServerInfo{
			ID:       s.Id,
			Address:  s.GrpcAddress,
			Suffrage: s.Suffrage,
			IsLeader: s.IsLeader,
		})
	}
	return out
}
```

- [ ] **Step 6: Wire it into `clusterMasters`**

In `clusterMasters`, capture raw reports alongside rows. Where `results` and `fetched` are declared (around line 99), add:

```go
		rawReports := make(map[string][]seaweed.MasterRaftServer)
```

Inside the batch loop, where `results[addr] = res.row` is set (around line 126), add:

```go
				rawReports[addr] = res.raftServers
```

After `consistency := buildMasterConsistency(rows)` and the row finalization loop (around line 148), compute the leader address and the raft servers:

```go
			leaderAddr := ""
			for _, row := range rows {
				if row.IsLeader {
					leaderAddr = row.Address
					break
				}
			}
			raftServers := pickRaftServers(rawReports, leaderAddr)
```

Then include it in the response literal:

```go
			c.JSON(http.StatusOK, clusterMastersResponse{
				Cluster:          cl,
				ConfiguredMaster: configured,
				Masters:          rows,
				Consistency:      consistency,
				RaftServers:      raftServers,
			})
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `go test ./internal/api/ -run TestPickRaftServers -v`
Expected: PASS.
Also: `gofmt -l internal/api/cluster_masters.go internal/api/cluster_masters_test.go` → prints nothing.

- [ ] **Step 8: Commit**

```bash
git add internal/api/cluster_masters.go internal/api/cluster_masters_test.go
git commit -m "feat(api): expose raft_servers (id+grpc addr) from masters endpoint"
```

---

## Task 5: Transfer-leader handler with pure helpers (TDD)

**Files:**
- Create: `internal/api/cluster_raft_transfer.go`
- Create: `internal/api/cluster_raft_transfer_test.go`

- [ ] **Step 1: Write the failing test**

Create `internal/api/cluster_raft_transfer_test.go`:

```go
package api

import (
	"reflect"
	"testing"
)

func TestValidateTransferTarget(t *testing.T) {
	cases := []struct {
		name    string
		id      string
		addr    string
		wantErr bool
	}{
		{name: "both empty (auto)", id: "", addr: "", wantErr: false},
		{name: "both set", id: "m2", addr: "10.0.0.2:19333", wantErr: false},
		{name: "id only", id: "m2", addr: "", wantErr: true},
		{name: "addr only", id: "", addr: "10.0.0.2:19333", wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := validateTransferTarget(tc.id, tc.addr)
			if (err != nil) != tc.wantErr {
				t.Fatalf("validateTransferTarget(%q,%q) err=%v, wantErr=%v", tc.id, tc.addr, err, tc.wantErr)
			}
		})
	}
}

func TestBuildTransferArgs(t *testing.T) {
	if got := buildTransferArgs("", ""); len(got) != 0 {
		t.Fatalf("auto mode should yield no args, got %v", got)
	}
	got := buildTransferArgs("m2", "10.0.0.2:19333")
	want := []string{"-id=m2", "-address=10.0.0.2:19333"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("buildTransferArgs = %v, want %v", got, want)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./internal/api/ -run "TestValidateTransferTarget|TestBuildTransferArgs" -v`
Expected: FAIL — `undefined: validateTransferTarget`, `undefined: buildTransferArgs`.

- [ ] **Step 3: Implement the handler + helpers**

Create `internal/api/cluster_raft_transfer.go`:

```go
package api

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/auth"
)

// transferLeaderTimeout bounds the shell call. The command itself does a
// 10s cluster list + a 30s transfer RPC, so 60s leaves headroom.
const transferLeaderTimeout = 60 * time.Second

// validateTransferTarget enforces that the optional target id and address
// are supplied together (or both omitted for auto-selection).
func validateTransferTarget(targetID, targetAddress string) error {
	if (targetID == "") != (targetAddress == "") {
		return fmt.Errorf("target_id and target_address must be provided together")
	}
	return nil
}

// buildTransferArgs renders the CLI flags. Empty target → no flags (the
// command auto-selects an eligible follower).
func buildTransferArgs(targetID, targetAddress string) []string {
	if targetID == "" {
		return []string{}
	}
	return []string{"-id=" + targetID, "-address=" + targetAddress}
}

// clusterRaftTransferLeader wraps `weed shell cluster.raft.transferLeader`.
// Gated by guardEmergencyAllow (emergency stop only — change/maintenance/
// holiday windows are intentionally allowed since this is a maintenance-prep
// action). Route cap: cluster.raft.transfer.
//
// POST /api/v1/clusters/:id/masters/transfer-leader
// Body (optional): {"target_id": "...", "target_address": "host:grpcPort"}
func clusterRaftTransferLeader(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad cluster id"})
			return
		}
		if !guardEmergencyAllow(d, c) {
			return
		}
		var body struct {
			TargetID      string `json:"target_id,omitempty"`
			TargetAddress string `json:"target_address,omitempty"`
		}
		_ = c.ShouldBindJSON(&body)
		body.TargetID = strings.TrimSpace(body.TargetID)
		body.TargetAddress = strings.TrimSpace(body.TargetAddress)
		if err := validateTransferTarget(body.TargetID, body.TargetAddress); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		cl, err := d.PG.GetCluster(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		args := buildTransferArgs(body.TargetID, body.TargetAddress)

		ctx, cancel := context.WithTimeout(c.Request.Context(), transferLeaderTimeout)
		defer cancel()
		out, runErr := d.Sw.RunShellCommandAtWithBin(ctx, cl.MasterAddr, cl.WeedBinPath,
			"cluster.raft.transferLeader", args, nil)

		p, _ := auth.Of(c)
		_ = d.PG.Audit(c.Request.Context(), p.Email, "cluster.raft.transfer-leader", "cluster", id.String(), map[string]any{
			"target_id":      body.TargetID,
			"target_address": body.TargetAddress,
			"ok":             runErr == nil,
		})

		if runErr != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": runErr.Error(), "output": out})
			return
		}
		c.JSON(http.StatusOK, gin.H{"output": out, "args": strings.Join(args, " ")})
	}
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `go test ./internal/api/ -run "TestValidateTransferTarget|TestBuildTransferArgs" -v`
Expected: PASS.
Also: `gofmt -l internal/api/cluster_raft_transfer.go internal/api/cluster_raft_transfer_test.go` → prints nothing.

- [ ] **Step 5: Commit**

```bash
git add internal/api/cluster_raft_transfer.go internal/api/cluster_raft_transfer_test.go
git commit -m "feat(api): cluster.raft.transferLeader handler (emergency-stop gated)"
```

---

## Task 6: Register the route + seed the capability

**Files:**
- Modify: `internal/api/server.go` (master/raft diagnostics block, around line 565-572)
- Create: `migrations/pg/051_cluster_raft_transfer_cap.sql`

- [ ] **Step 1: Register the route**

In `internal/api/server.go`, in the `--- Cluster master/raft diagnostics ---` block, right after the `masters/lock-probe` route, add:

```go
		// Graceful raft leadership transfer (maintenance prep). Emergency-
		// stop gated only — must work during change/maintenance windows.
		v1.POST("/clusters/:id/masters/transfer-leader",
			auth.RequireCap(d.Caps, "cluster.raft.transfer"), clusterRaftTransferLeader(d))
```

- [ ] **Step 2: Create the migration**

Create `migrations/pg/051_cluster_raft_transfer_cap.sql`:

```sql
-- Seed cluster.raft.transfer capability for the new
-- /clusters/:id/masters/transfer-leader route. This is a MUTATING raft
-- operation (it triggers a brief leader re-election), so only admin and
-- operator get it — viewers and auditors do not.

INSERT INTO capabilities (name, category, label, description) VALUES
  ('cluster.raft.transfer', 'cluster', 'Transfer raft leadership',
   'Gracefully transfer SeaweedFS master raft leadership to another master (auto or a chosen target), typically before maintaining the current leader.')
ON CONFLICT (name) DO UPDATE
  SET category    = EXCLUDED.category,
      label       = EXCLUDED.label,
      description = EXCLUDED.description;

INSERT INTO role_capabilities (role, capability) VALUES
  ('admin',    'cluster.raft.transfer'),
  ('operator', 'cluster.raft.transfer')
ON CONFLICT DO NOTHING;
```

- [ ] **Step 3: Verify**

Run:
```bash
gofmt -l internal/api/server.go
grep -n "transfer-leader\|cluster.raft.transfer" internal/api/server.go
ls migrations/pg/051_cluster_raft_transfer_cap.sql
```
Expected: `gofmt -l` prints nothing; grep shows the route + cap; the migration file exists.

- [ ] **Step 4: Commit**

```bash
git add internal/api/server.go migrations/pg/051_cluster_raft_transfer_cap.sql
git commit -m "feat(api): route + capability for cluster.raft.transfer"
```

---

## Task 7: Frontend API client — types + `transferLeader`

**Files:**
- Modify: `web/lib/api.ts` (ClusterMasterRow region ~line 1363-1399; api object ~line 1855)

- [ ] **Step 1: Add the `RaftServerInfo` type and `raft_servers` field**

In `web/lib/api.ts`, add the interface right after `ClusterMasterRow` (after line 1376):

```ts
export interface RaftServerInfo {
  id: string;
  address: string; // gRPC address — passed back as target_address
  suffrage: "leader" | "voter" | "nonvoter" | "unknown" | string;
  is_leader: boolean;
}
```

Add the field to `ClusterMastersResponse`:

```ts
export interface ClusterMastersResponse {
  cluster: { id: string; name: string; master_addr: string };
  configured_master: string;
  masters: ClusterMasterRow[];
  consistency: MasterConsistency;
  raft_servers: RaftServerInfo[];
}
```

- [ ] **Step 2: Add the `transferLeader` API method**

In the `api` object, right after the `lockProbe` method (after line 1866), add:

```ts
  transferLeader: (
    clusterID: string,
    b?: { target_id: string; target_address: string },
  ) =>
    jpost(`${BASE}/clusters/${clusterID}/masters/transfer-leader`, b ?? {}) as Promise<{
      output: string;
      args: string;
    }>,
```

- [ ] **Step 3: Verify no new type errors**

Run: `npm run typecheck 2>&1 | grep "lib/api.ts"`
Expected: no NEW errors for `lib/api.ts` versus the baseline (ideally no lines).

- [ ] **Step 4: Commit**

```bash
git add web/lib/api.ts
git commit -m "feat(web): RaftServerInfo type + api.transferLeader client"
```

---

## Task 8: Frontend — "Raft leadership" card on the masters page

**Files:**
- Modify: `web/app/clusters/[id]/masters/page.tsx`

- [ ] **Step 1: Import the icon and type**

At the top of `web/app/clusters/[id]/masters/page.tsx`, extend the existing imports:

- Add `Crown` to the `lucide-react` import (line 4): `import { Loader2, ShieldCheck, AlertTriangle, RefreshCw, Crown } from "lucide-react";`
- Add `type RaftServerInfo` to the `@/lib/api` import (line 5-10 block).

- [ ] **Step 2: Add transfer state + handler inside `ClusterMastersPage`**

After the existing `const [probing, setProbing] = useState(false);` (line 31), add:

```tsx
  const [target, setTarget] = useState(""); // "" = auto; else "id|grpcAddr"
  const [transferring, setTransferring] = useState(false);
  const [transferResult, setTransferResult] = useState<string | null>(null);
```

After the `runProbe` function (after line 70), add:

```tsx
  const canTransfer = has("cluster.raft.transfer");

  async function runTransfer() {
    if (!window.confirm(t("Transfer raft leadership to another master? This triggers a brief re-election."))) {
      return;
    }
    setTransferring(true);
    setTransferResult(null);
    try {
      let body: { target_id: string; target_address: string } | undefined;
      if (target) {
        const [id2, addr] = target.split("|");
        body = { target_id: id2, target_address: addr };
      }
      const res = await api.transferLeader(id, body);
      setTransferResult(res.output);
      mutate();
    } catch (e) {
      setTransferResult(e instanceof Error ? e.message : String(e));
    } finally {
      setTransferring(false);
    }
  }
```

- [ ] **Step 3: Render the card**

Immediately after the closing `</section>` of the Lock probe card (after line 139, before the final `</div>`), add:

```tsx
      <section className="card p-4 space-y-3">
        <header className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h3 className="text-sm font-semibold inline-flex items-center gap-2">
              <Crown size={14}/> {t("Raft leadership")}
            </h3>
            <p className="text-xs text-muted">
              {t("Gracefully move master raft leadership to another node before maintaining the current leader. Allowed during change/maintenance windows; blocked only by emergency stop.")}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <select
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              disabled={!canTransfer || transferring}
              className="input text-xs"
            >
              <option value="">{t("Auto (any eligible follower)")}</option>
              {data.raft_servers
                .filter((s: RaftServerInfo) => !s.is_leader && s.suffrage === "voter")
                .map((s: RaftServerInfo) => (
                  <option key={s.id} value={`${s.id}|${s.address}`}>
                    {s.id} — {s.address}
                  </option>
                ))}
            </select>
            <button
              onClick={runTransfer}
              disabled={!canTransfer || transferring}
              title={canTransfer ? t("Transfer leader") : t("Requires cluster.raft.transfer capability")}
              className="btn btn-primary inline-flex items-center gap-1"
            >
              {transferring ? <Loader2 size={12} className="animate-spin"/> : <Crown size={12}/>}
              {t("Transfer leader")}
            </button>
          </div>
        </header>
        {transferResult !== null && (
          <pre className="font-mono text-[11px] bg-bg/60 border border-border rounded p-3 whitespace-pre-wrap max-h-60 overflow-auto">
            {transferResult}
          </pre>
        )}
      </section>
```

(Note: the `input`, `btn`/`btn-primary` classes and the `<pre>` styling above are copied from existing components — `shell-console.tsx` uses the same `bg-bg/60 border border-border` for command output, and the masters page already uses `card`/`btn-primary`.)

- [ ] **Step 4: Verify no new type errors**

Run: `npm run typecheck 2>&1 | grep "masters/page.tsx"`
Expected: no NEW errors versus baseline.

- [ ] **Step 5: Commit**

```bash
git add "web/app/clusters/[id]/masters/page.tsx"
git commit -m "feat(web): raft leadership transfer card on masters page"
```

---

## Task 9: i18n keys

**Files:**
- Modify: `web/lib/i18n.ts`

- [ ] **Step 1: Add the zh keys**

In `web/lib/i18n.ts`, add these entries to the zh translation map (match the existing object syntax — `"English": "中文",`):

```ts
  "Raft leadership": "Raft 领导权",
  "Transfer leader": "转移 leader",
  "Auto (any eligible follower)": "自动(任一可用 follower)",
  "Transfer raft leadership to another master? This triggers a brief re-election.": "将 raft 领导权转移到另一台 master?这会触发一次短暂的重新选举。",
  "Requires cluster.raft.transfer capability": "需要 cluster.raft.transfer 权限",
  "Gracefully move master raft leadership to another node before maintaining the current leader. Allowed during change/maintenance windows; blocked only by emergency stop.": "在维护当前 leader 前,优雅地把 master raft 领导权转移到另一台节点。变更/维护窗口期间允许;仅紧急停止会拦截。",
```

- [ ] **Step 2: Verify no new type errors**

Run: `npm run typecheck 2>&1 | grep "lib/i18n.ts"`
Expected: no NEW errors versus baseline. (Note: `i18n.ts` has a pre-existing TS1117 duplicate-key baseline — ensure you are not adding a key that already exists; `grep -n "Raft leadership" web/lib/i18n.ts` should show exactly one occurrence after your edit.)

- [ ] **Step 3: Commit**

```bash
git add web/lib/i18n.ts
git commit -m "feat(web): zh i18n keys for raft leadership transfer"
```

---

## Final Verification (after all tasks)

- [ ] **Backend build (user / Go 1.25 env):** `go build ./...` then `go test ./internal/safety/ ./internal/api/ -run "Emergency|RaftServers|TransferTarget|TransferArgs" -v` — all PASS.
- [ ] **Frontend:** `npm run typecheck 2>&1 | grep -E "api.ts|masters/page.tsx|i18n.ts"` shows no NEW errors versus baseline; `npm run build` succeeds.
- [ ] **Migration:** confirm `051_cluster_raft_transfer_cap.sql` applies cleanly and `cluster.raft.transfer` appears for admin/operator.
- [ ] **Manual smoke (multi-master cluster):** open masters page → "Raft leadership" card shows voter dropdown → click "Transfer leader" (auto) → confirm → output shows "Leadership successfully transferred" and the masters table reflects the new leader after refresh. With emergency stop engaged, the button returns 423.
- [ ] Dispatch final code reviewer; then use superpowers:finishing-a-development-branch.
