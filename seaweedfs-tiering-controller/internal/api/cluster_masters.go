package api

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"golang.org/x/sync/errgroup"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/seaweed"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

const masterDiagnosticsTimeout = 2 * time.Second

// adminLockNameShell is the lockName the SeaweedFS shell uses
// (`exclusive_locks.NewExclusiveLocker(client, "shell")`). Probing that name
// is what tells operators whether `weed shell` would actually be able to
// acquire the cluster admin lock right now.
const adminLockNameShell = "shell"

// lockProbeTimeout caps any single LeaseAdminToken round-trip. Held locks
// fail almost immediately with a textual error; this exists so an
// unreachable master can't pin the request.
const lockProbeTimeout = 2 * time.Second

type clusterMasterRow struct {
	Address         string   `json:"address"`
	Reachable       bool     `json:"reachable"`
	LatencyMS       int64    `json:"latency_ms"`
	IsLeader        bool     `json:"is_leader"`
	Suffrage        string   `json:"suffrage"`
	ReportedLeader  string   `json:"reported_leader,omitempty"`
	ReportedPeers   []string `json:"reported_peers"`
	NormalizedPeers []string `json:"normalized_peers"`
	LockHolder      string   `json:"lock_holder,omitempty"`
	Warnings        []string `json:"warnings"`
	Health          string   `json:"health"`
	Error           string   `json:"error,omitempty"`

	PeerDataAvailable      bool     `json:"-"`
	normalizedPeerObserved []string `json:"-"`
}

type masterConsistencyIssue struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type masterConsistency struct {
	Healthy          bool                     `json:"healthy"`
	LeaderAgreement  bool                     `json:"leader_agreement"`
	PeerSetAgreement bool                     `json:"peer_set_agreement"`
	ExpectedPeers    []string                 `json:"expected_peers"`
	ReportedLeaders  []string                 `json:"reported_leaders"`
	Issues           []masterConsistencyIssue `json:"issues"`
}

// raftServerInfo is the wire representation of a single raft peer, used by the
// frontend leadership-transfer target picker.
type raftServerInfo struct {
	ID       string `json:"id"`
	Address  string `json:"address"` // gRPC address — what transferLeader -address expects
	Suffrage string `json:"suffrage"`
	IsLeader bool   `json:"is_leader"`
}

type clusterMastersResponse struct {
	Cluster          *store.Cluster     `json:"cluster"`
	ConfiguredMaster string             `json:"configured_master"`
	Masters          []clusterMasterRow `json:"masters"`
	Consistency      masterConsistency  `json:"consistency"`
	RaftServers      []raftServerInfo   `json:"raft_servers"`
}

type masterFetchResult struct {
	row         clusterMasterRow
	discovery   []string
	raftServers []seaweed.MasterRaftServer
}

func clusterMasters(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad cluster id"})
			return
		}
		cl, err := d.PG.GetCluster(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}

		configured := normalizeMasterPeer(cl.MasterAddr)
		discovered := map[string]struct{}{}
		if configured != "" {
			discovered[configured] = struct{}{}
		}

		results := make(map[string]clusterMasterRow)
		fetched := make(map[string]struct{})
		rawReports := make(map[string][]seaweed.MasterRaftServer)
		for pass := 0; pass < 3; pass++ {
			pending := make([]string, 0, len(discovered))
			for addr := range discovered {
				if _, ok := fetched[addr]; ok {
					continue
				}
				pending = append(pending, addr)
			}
			if len(pending) == 0 {
				break
			}
			sort.Strings(pending)
			batch := fetchMasterBatch(c.Request.Context(), d.Sw, pending)
			for _, addr := range pending {
				fetched[addr] = struct{}{}
				res, ok := batch[addr]
				if !ok {
					results[addr] = clusterMasterRow{
						Address:  addr,
						Suffrage: "unknown",
						Health:   "err",
						Error:    "master fetch did not return a result",
					}
					continue
				}
				results[addr] = res.row
				// Keyed by normalized HTTP address (same as row.Address), so
				// pickRaftServers can match leaderAddr below.
				rawReports[addr] = res.raftServers
				for _, peer := range res.discovery {
					if peer == "" {
						continue
					}
					discovered[peer] = struct{}{}
				}
			}
		}

		rows := make([]clusterMasterRow, 0, len(results))
		for _, row := range results {
			rows = append(rows, row)
		}
		sort.Slice(rows, func(i, j int) bool {
			return rows[i].Address < rows[j].Address
		})

		consistency := buildMasterConsistency(rows)
		for i := range rows {
			rows[i].Warnings = buildMasterRowWarnings(rows[i])
			rows[i].Health = classifyMasterHealth(rows[i], consistency)
		}

		// Take the first leader in sorted order; split-brain (multiple
		// self-reported leaders) is surfaced separately in consistency issues.
		leaderAddr := ""
		for _, row := range rows {
			if row.IsLeader {
				leaderAddr = row.Address
				break
			}
		}
		raftServers := pickRaftServers(rawReports, leaderAddr)

		c.JSON(http.StatusOK, clusterMastersResponse{
			Cluster:          cl,
			ConfiguredMaster: configured,
			Masters:          rows,
			Consistency:      consistency,
			RaftServers:      raftServers,
		})
	}
}

func fetchMasterBatch(ctx context.Context, sw *seaweed.Client, addrs []string) map[string]masterFetchResult {
	out := make(map[string]masterFetchResult, len(addrs))
	var mu sync.Mutex
	var g errgroup.Group

	for _, addr := range addrs {
		addr := addr
		g.Go(func() error {
			res := fetchMaster(ctx, sw, addr)
			mu.Lock()
			out[addr] = res
			mu.Unlock()
			return nil
		})
	}
	_ = g.Wait()
	return out
}

func fetchMaster(ctx context.Context, sw *seaweed.Client, addr string) masterFetchResult {
	row := clusterMasterRow{
		Address:         addr,
		Suffrage:        "unknown",
		ReportedPeers:   []string{},
		NormalizedPeers: []string{},
		Warnings:        []string{},
	}
	discovery := map[string]struct{}{addr: {}}

	var (
		status     seaweed.MasterStatusSnapshot
		statusRTT  time.Duration
		statusErr  error
		metricsRaw string
		metricsRTT time.Duration
		metricsErr error
		raftPeers  []seaweed.MasterRaftServer
		raftRTT    time.Duration
		raftErr    error
	)
	var capturedRaft []seaweed.MasterRaftServer

	var g errgroup.Group
	g.Go(func() error {
		subctx, cancel := context.WithTimeout(ctx, masterDiagnosticsTimeout)
		defer cancel()
		status, statusRTT, statusErr = sw.FetchMasterStatus(subctx, addr)
		return nil
	})
	g.Go(func() error {
		subctx, cancel := context.WithTimeout(ctx, masterDiagnosticsTimeout)
		defer cancel()
		metricsRaw, metricsRTT, metricsErr = sw.FetchMasterMetrics(subctx, addr)
		return nil
	})
	g.Go(func() error {
		subctx, cancel := context.WithTimeout(ctx, masterDiagnosticsTimeout)
		defer cancel()
		raftPeers, raftRTT, raftErr = sw.FetchMasterRaftServers(subctx, addr)
		return nil
	})
	_ = g.Wait()

	latencies := make([]time.Duration, 0, 3)
	if statusErr == nil {
		latencies = append(latencies, statusRTT)
		row.Reachable = true
		row.IsLeader = status.IsLeader
		row.ReportedLeader = normalizeMasterPeer(status.Leader)
		row.ReportedPeers = append(row.ReportedPeers, status.Peers...)
		row.normalizedPeerObserved = normalizeMasterPeerObserved(status.Peers)
		row.NormalizedPeers = uniqueNormalizedPeers(row.normalizedPeerObserved)
		row.PeerDataAvailable = len(row.normalizedPeerObserved) > 0 || row.ReportedLeader != "" || row.IsLeader
		if row.ReportedLeader != "" {
			discovery[row.ReportedLeader] = struct{}{}
		}
		for _, peer := range row.NormalizedPeers {
			discovery[peer] = struct{}{}
		}
	}
	if metricsErr == nil {
		latencies = append(latencies, metricsRTT)
		row.Reachable = true
		row.LockHolder = extractLockHolder(metricsRaw)
	}
	if raftErr == nil {
		latencies = append(latencies, raftRTT)
		row.Reachable = true
		capturedRaft = append([]seaweed.MasterRaftServer(nil), raftPeers...)
		raftObserved := make([]string, 0, len(raftPeers))
		raftLeader := ""
		for _, peer := range raftPeers {
			normalized := normalizeMasterPeer(peer.Address)
			if normalized == "" {
				continue
			}
			raftObserved = append(raftObserved, normalized)
			discovery[normalized] = struct{}{}
			if normalized == row.Address {
				row.Suffrage = normalizeSuffrage(peer.Suffrage, peer.IsLeader)
			}
			if peer.IsLeader {
				raftLeader = normalized
				if normalized == row.Address {
					row.IsLeader = true
				}
			}
		}
		if row.ReportedLeader == "" {
			row.ReportedLeader = raftLeader
		}
		if len(row.ReportedPeers) == 0 && len(raftObserved) > 0 {
			row.ReportedPeers = append([]string(nil), raftObserved...)
		}
		row.normalizedPeerObserved = mergePeerObservations(row.normalizedPeerObserved, raftObserved)
		row.NormalizedPeers = uniqueNormalizedPeers(row.normalizedPeerObserved)
		if len(row.normalizedPeerObserved) > 0 || row.ReportedLeader != "" || row.IsLeader {
			row.PeerDataAvailable = true
		}
	}

	if row.IsLeader {
		row.Suffrage = "leader"
	}

	if len(latencies) > 0 {
		row.LatencyMS = minDuration(latencies).Milliseconds()
	}

	if !row.Reachable {
		row.Error = joinErrors(statusErr, metricsErr, raftErr)
	}

	return masterFetchResult{
		row:         row,
		discovery:   sortedKeys(discovery),
		raftServers: capturedRaft,
	}
}

func normalizeMasterPeer(raw string) string {
	trimmed := cleanMasterPeerValue(raw)
	if trimmed == "" {
		return ""
	}
	if httpAddr, ok := trimMasterGrpcSuffix(trimmed); ok {
		return httpAddr
	}
	host, port, err := net.SplitHostPort(trimmed)
	if err != nil {
		return trimmed
	}
	portNum, err := strconv.Atoi(port)
	if err != nil || portNum < 18000 {
		return trimmed
	}
	return net.JoinHostPort(host, strconv.Itoa(portNum-10000))
}

func extractLockHolder(metrics string) string {
	for _, line := range strings.Split(metrics, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "SeaweedFS_master_admin_lock{") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		value, err := strconv.ParseFloat(fields[len(fields)-1], 64)
		if err != nil || value <= 0 {
			continue
		}
		start := strings.Index(line, `client="`)
		if start < 0 {
			continue
		}
		start += len(`client="`)
		end := strings.Index(line[start:], `"`)
		if end < 0 {
			continue
		}
		return line[start : start+end]
	}
	return ""
}

func buildMasterConsistency(rows []clusterMasterRow) masterConsistency {
	consistency := masterConsistency{
		Healthy:          true,
		LeaderAgreement:  true,
		PeerSetAgreement: true,
		ExpectedPeers:    []string{},
		ReportedLeaders:  []string{},
		Issues:           []masterConsistencyIssue{},
	}

	expected := map[string]struct{}{}
	leaders := map[string]struct{}{}
	peerSets := map[string]struct{}{}
	rawVariants := map[string]map[string]struct{}{}
	reachableCount := 0

	for _, row := range rows {
		if row.Address != "" {
			expected[row.Address] = struct{}{}
		}
		if !row.Reachable {
			consistency.Healthy = false
			consistency.Issues = append(consistency.Issues, masterConsistencyIssue{
				Code:    "unreachable_master",
				Message: fmt.Sprintf("%s is unreachable: %s", row.Address, row.Error),
			})
			continue
		}

		reachableCount++
		leader := derivedLeader(row)
		if leader != "" {
			expected[leader] = struct{}{}
			leaders[leader] = struct{}{}
			if row.PeerDataAvailable && !containsString(row.NormalizedPeers, leader) {
				consistency.Healthy = false
				consistency.Issues = append(consistency.Issues, masterConsistencyIssue{
					Code:    "leader_missing_from_peers",
					Message: fmt.Sprintf("%s reports leader %s outside its peer set", row.Address, leader),
				})
			}
		}
		if row.PeerDataAvailable && row.Address != "" && !containsString(row.NormalizedPeers, row.Address) {
			consistency.Healthy = false
			consistency.Issues = append(consistency.Issues, masterConsistencyIssue{
				Code:    "missing_self",
				Message: fmt.Sprintf("%s is missing from its own peer list", row.Address),
			})
		}
		if row.PeerDataAvailable && hasDuplicates(peerObservations(row)) {
			consistency.Healthy = false
			consistency.Issues = append(consistency.Issues, masterConsistencyIssue{
				Code:    "duplicate_peer_entries",
				Message: fmt.Sprintf("%s reports duplicate peer entries", row.Address),
			})
		}
		if row.PeerDataAvailable {
			for _, peer := range row.NormalizedPeers {
				expected[peer] = struct{}{}
			}
			peerSets[canonicalStringSet(row.NormalizedPeers)] = struct{}{}
		}

		for _, raw := range row.ReportedPeers {
			registerPeerVariant(rawVariants, raw)
		}
		registerPeerVariant(rawVariants, row.ReportedLeader)
	}

	if reachableCount == 0 {
		consistency.Healthy = false
		consistency.LeaderAgreement = false
		consistency.PeerSetAgreement = false
		consistency.Issues = append(consistency.Issues, masterConsistencyIssue{
			Code:    "no_reachable_masters",
			Message: "no master endpoints returned any diagnostic data",
		})
	}
	if reachableCount > 0 && len(leaders) == 0 {
		consistency.Healthy = false
		consistency.LeaderAgreement = false
		consistency.Issues = append(consistency.Issues, masterConsistencyIssue{
			Code:    "no_leader",
			Message: "reachable masters did not yield a leader",
		})
	}
	if len(leaders) > 1 {
		consistency.Healthy = false
		consistency.LeaderAgreement = false
		consistency.Issues = append(consistency.Issues, masterConsistencyIssue{
			Code:    "leader_disagreement",
			Message: fmt.Sprintf("masters disagree on the leader: %s", strings.Join(sortedKeys(leaders), ", ")),
		})
	}
	if len(peerSets) > 1 {
		consistency.Healthy = false
		consistency.PeerSetAgreement = false
		consistency.Issues = append(consistency.Issues, masterConsistencyIssue{
			Code:    "peer_set_disagreement",
			Message: "masters report different normalized peer sets",
		})
	}
	for normalized, variants := range rawVariants {
		if len(variants) < 2 {
			continue
		}
		consistency.Issues = append(consistency.Issues, masterConsistencyIssue{
			Code:    "peer_format_divergence",
			Message: fmt.Sprintf("%s appears with multiple raw formats: %s", normalized, strings.Join(sortedKeys(variants), ", ")),
		})
	}

	consistency.ExpectedPeers = sortedKeys(expected)
	consistency.ReportedLeaders = sortedKeys(leaders)
	return consistency
}

func classifyMasterHealth(row clusterMasterRow, consistency masterConsistency) string {
	if !row.Reachable {
		return "err"
	}
	if !consistency.LeaderAgreement || !consistency.PeerSetAgreement {
		return "err"
	}
	if len(row.Warnings) > 0 {
		return "warn"
	}
	return "ok"
}

func buildMasterRowWarnings(row clusterMasterRow) []string {
	if !row.Reachable {
		return nil
	}
	warnings := make([]string, 0, 4)
	if row.PeerDataAvailable && row.Address != "" && !containsString(row.NormalizedPeers, row.Address) {
		warnings = append(warnings, "missing_self")
	}
	if row.PeerDataAvailable && hasDuplicates(peerObservations(row)) {
		warnings = append(warnings, "duplicate_peers")
	}
	if leader := derivedLeader(row); row.PeerDataAvailable && leader != "" && !containsString(row.NormalizedPeers, leader) {
		warnings = append(warnings, "leader_missing_from_peers")
	}
	if hasPeerFormatNormalization(row.ReportedLeader, row.ReportedPeers) {
		warnings = append(warnings, "peer_format_normalized")
	}
	return uniqueSortedStrings(warnings)
}

func cleanMasterPeerValue(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	if parsed, err := url.Parse(trimmed); err == nil && parsed.Host != "" {
		trimmed = parsed.Host
	}
	if idx := strings.IndexAny(trimmed, "/?#"); idx >= 0 {
		trimmed = trimmed[:idx]
	}
	return strings.TrimSpace(strings.TrimRight(trimmed, "/"))
}

func normalizeMasterPeerObserved(values []string) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		normalized := normalizeMasterPeer(value)
		if normalized == "" {
			continue
		}
		out = append(out, normalized)
	}
	return out
}

func normalizeSuffrage(suffrage string, isLeader bool) string {
	if isLeader {
		return "leader"
	}
	switch strings.ToLower(strings.TrimSpace(suffrage)) {
	case "voter":
		return "voter"
	case "nonvoter", "non-voter", "staging":
		return "nonvoter"
	default:
		return "unknown"
	}
}

func registerPeerVariant(variants map[string]map[string]struct{}, raw string) {
	normalized := normalizeMasterPeer(raw)
	cleaned := cleanMasterPeerValue(raw)
	if normalized == "" || cleaned == "" {
		return
	}
	m, ok := variants[normalized]
	if !ok {
		m = map[string]struct{}{}
		variants[normalized] = m
	}
	m[cleaned] = struct{}{}
}

func hasPeerFormatNormalization(reportedLeader string, reportedPeers []string) bool {
	check := func(raw string) bool {
		cleaned := cleanMasterPeerValue(raw)
		normalized := normalizeMasterPeer(raw)
		return cleaned != "" && normalized != "" && cleaned != normalized
	}
	if check(reportedLeader) {
		return true
	}
	for _, peer := range reportedPeers {
		if check(peer) {
			return true
		}
	}
	return false
}

func hasDuplicates(values []string) bool {
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		if _, ok := seen[value]; ok {
			return true
		}
		seen[value] = struct{}{}
	}
	return false
}

func peerObservations(row clusterMasterRow) []string {
	if len(row.normalizedPeerObserved) > 0 {
		return row.normalizedPeerObserved
	}
	return row.NormalizedPeers
}

func uniqueNormalizedPeers(values []string) []string {
	return uniqueSortedStrings(values)
}

func mergePeerObservations(current, backfill []string) []string {
	if len(backfill) == 0 {
		return current
	}
	out := append([]string(nil), current...)
	seen := make(map[string]struct{}, len(current))
	for _, value := range current {
		seen[value] = struct{}{}
	}
	for _, value := range backfill {
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out
}

func derivedLeader(row clusterMasterRow) string {
	if row.IsLeader && row.Address != "" {
		return row.Address
	}
	return normalizeMasterPeer(row.ReportedLeader)
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func canonicalStringSet(values []string) string {
	cloned := append([]string(nil), values...)
	sort.Strings(cloned)
	return strings.Join(cloned, ",")
}

func uniqueSortedStrings(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	sort.Strings(out)
	return out
}

func sortedKeys[M ~map[string]V, V any](m M) []string {
	out := make([]string, 0, len(m))
	for key := range m {
		if key == "" {
			continue
		}
		out = append(out, key)
	}
	sort.Strings(out)
	return out
}

func minDuration(values []time.Duration) time.Duration {
	best := values[0]
	for _, value := range values[1:] {
		if value < best {
			best = value
		}
	}
	return best
}

func joinErrors(errs ...error) string {
	parts := make([]string, 0, len(errs))
	for _, err := range errs {
		if err == nil {
			continue
		}
		parts = append(parts, err.Error())
	}
	return strings.Join(parts, "; ")
}

type lockProbeRequest struct {
	Address  string `json:"address,omitempty"`
	LockName string `json:"lock_name,omitempty"`
}

type lockProbeResponse struct {
	Status    string `json:"status"` // free | held | quorum_unhealthy
	Address   string `json:"address"`
	LockName  string `json:"lock_name"`
	Holder    string `json:"holder,omitempty"`
	Message   string `json:"message,omitempty"`
	LatencyMS int64  `json:"latency_ms,omitempty"`
}

func clusterMasterLockProbe(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad cluster id"})
			return
		}
		cl, err := d.PG.GetCluster(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}

		var body lockProbeRequest
		// Empty body is fine; binding errors are not fatal because the
		// fields are all optional and a missing body means "pick a master
		// yourself and probe the default lock".
		_ = c.ShouldBindJSON(&body)

		lockName := strings.TrimSpace(body.LockName)
		if lockName == "" {
			lockName = adminLockNameShell
		}

		// Caller can pin the probe to a specific master (e.g. testing
		// individual nodes); otherwise we pick the leader from the same
		// aggregation pipeline the GET /masters page uses.
		target := normalizeMasterPeer(body.Address)
		if target == "" {
			target = pickProbeTarget(c.Request.Context(), d.Sw, cl.MasterAddr)
		}
		if target == "" {
			c.JSON(http.StatusOK, lockProbeResponse{
				Status:   "quorum_unhealthy",
				LockName: lockName,
				Message:  "no reachable master with a known leader",
			})
			return
		}

		ctx, cancel := context.WithTimeout(c.Request.Context(), lockProbeTimeout)
		defer cancel()
		clientName := lockProbeClientName(c)
		outcome, latency, probeErr := d.Sw.ProbeMasterAdminLock(ctx, target, lockName, clientName)
		resp := mapLockProbeResult(target, lockName, outcome, probeErr)
		resp.LatencyMS = latency.Milliseconds()
		c.JSON(http.StatusOK, resp)
	}
}

// pickProbeTarget resolves a master address that's worth probing — the
// raft leader if we can find one, otherwise the configured master. Returns
// "" only when even the configured master normalizes to empty.
func pickProbeTarget(ctx context.Context, sw *seaweed.Client, configured string) string {
	target := normalizeMasterPeer(configured)
	probeCtx, cancel := context.WithTimeout(ctx, masterDiagnosticsTimeout)
	defer cancel()
	if target != "" {
		if status, _, err := sw.FetchMasterStatus(probeCtx, target); err == nil {
			if status.IsLeader {
				return target
			}
			if leader := normalizeMasterPeer(status.Leader); leader != "" {
				return leader
			}
		}
	}
	return target
}

func lockProbeClientName(c *gin.Context) string {
	user := strings.TrimSpace(c.GetString("user"))
	if user == "" {
		user = "anonymous"
	}
	return "tiering-controller/probe/" + user
}

// mapLockProbeResult turns a seaweed.LockProbeOutcome (plus the raw gRPC
// error) into the JSON status the frontend renders. Centralised so tests
// can assert the mapping without spinning up a master.
func mapLockProbeResult(addr, lockName string, outcome seaweed.LockProbeOutcome, err error) lockProbeResponse {
	resp := lockProbeResponse{Address: addr, LockName: lockName}
	switch {
	case outcome.Acquired:
		resp.Status = "free"
	case outcome.Held:
		resp.Status = "held"
		resp.Holder = outcome.Holder
		resp.Message = outcome.RawError
	case outcome.NotLeader:
		resp.Status = "quorum_unhealthy"
		resp.Message = "master is not the raft leader: " + outcome.RawError
	case err != nil:
		resp.Status = "quorum_unhealthy"
		if outcome.RawError != "" {
			resp.Message = outcome.RawError
		} else {
			resp.Message = err.Error()
		}
	default:
		resp.Status = "quorum_unhealthy"
		resp.Message = "probe returned no outcome"
	}
	return resp
}

func trimMasterGrpcSuffix(addr string) (string, bool) {
	host, ports, ok := strings.Cut(addr, ":")
	if !ok {
		return "", false
	}
	httpPort, _, ok := strings.Cut(ports, ".")
	if !ok {
		return "", false
	}
	return net.JoinHostPort(host, httpPort), true
}

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
			Suffrage: normalizeSuffrage(s.Suffrage, s.IsLeader),
			IsLeader: s.IsLeader,
		})
	}
	return out
}
