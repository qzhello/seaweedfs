package seaweed

// Cluster-wide physical disk usage, scraped from each volume server's
// `GET http://{publicURL}/status` JSON endpoint. Master topology only
// reports slot counts; the per-volume-server /status response carries
// the real filesystem byte counters (the same numbers /metrics exposes).
//
// Results are cached for 30s per master so a busy dashboard doesn't
// hammer every volume server on each refresh.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
)

// VolumeServerStatus is the subset of /status we care about. The real
// payload has more fields (Volumes, EcShards, etc.) which we ignore.
type VolumeServerStatus struct {
	Version      string       `json:"Version"`
	DiskStatuses []DiskStatus `json:"DiskStatuses"`
}

// DiskStatus mirrors weed/stats.DiskStatus: bytes from statfs on the
// volume server's data directory.
type DiskStatus struct {
	Dir         string  `json:"dir"`
	All         uint64  `json:"all"`
	Used        uint64  `json:"used"`
	Free        uint64  `json:"free"`
	PercentUsed float64 `json:"percent_used"`
	PercentFree float64 `json:"percent_free"`
}

// NodeDiskUsage is the per-volume-server slice of the aggregate.
type NodeDiskUsage struct {
	Server     string   `json:"server"` // host:port (master's DataNode.Id)
	TotalBytes uint64   `json:"total_bytes"`
	UsedBytes  uint64   `json:"used_bytes"`
	FreeBytes  uint64   `json:"free_bytes"`
	Dirs       []string `json:"dirs,omitempty"` // mount points reported
	Reachable  bool     `json:"reachable"`
	Error      string   `json:"error,omitempty"`
}

// ClusterDiskUsage is the cluster-level aggregate the dashboard's water
// gauge consumes. Bytes are summed across every reachable volume server.
type ClusterDiskUsage struct {
	TotalBytes uint64          `json:"total_bytes"`
	UsedBytes  uint64          `json:"used_bytes"`
	FreeBytes  uint64          `json:"free_bytes"`
	Nodes      []NodeDiskUsage `json:"nodes"`
	FetchedAt  time.Time       `json:"fetched_at"`
	Stale      bool            `json:"stale"`
}

const (
	diskStatusTimeout = 3 * time.Second
	diskStatusTTL     = 30 * time.Second
)

type diskUsageCacheEntry struct {
	val ClusterDiskUsage
	at  time.Time
}

var (
	diskUsageCacheMu sync.Mutex
	diskUsageCache   = map[string]diskUsageCacheEntry{}
)

// FetchClusterDiskUsage returns the aggregate physical disk usage for
// the cluster reachable via masterAddr. Internally:
//   1. ListNodesAt — pulls volume-server addresses from master topology
//   2. parallel GET /status on each
//   3. sum DiskStatuses[].{all,used,free}
// A 30s TTL keeps the cost off the hot path; pass forceRefresh=true to
// bypass the cache.
func (c *Client) FetchClusterDiskUsage(ctx context.Context, masterAddr string, forceRefresh bool) (ClusterDiskUsage, error) {
	key := masterAddr
	if !forceRefresh {
		diskUsageCacheMu.Lock()
		e, ok := diskUsageCache[key]
		diskUsageCacheMu.Unlock()
		if ok && time.Since(e.at) < diskStatusTTL {
			return e.val, nil
		}
	}

	nodes, err := c.ListNodesAt(ctx, masterAddr)
	if err != nil {
		return ClusterDiskUsage{}, fmt.Errorf("list nodes: %w", err)
	}

	// One slot per unique server — a node with multiple disk types
	// appears once per DiskInfo in ListNodesAt, but /status returns
	// every mount at once so we only need one HTTP per host:port.
	seen := map[string]struct{}{}
	servers := make([]string, 0, len(nodes))
	for _, n := range nodes {
		if n.Server == "" {
			continue
		}
		if _, dup := seen[n.Server]; dup {
			continue
		}
		seen[n.Server] = struct{}{}
		servers = append(servers, n.Server)
	}

	results := make([]NodeDiskUsage, len(servers))
	var wg sync.WaitGroup
	for i, srv := range servers {
		i, srv := i, srv
		wg.Add(1)
		go func() {
			defer wg.Done()
			results[i] = fetchOne(ctx, srv)
		}()
	}
	wg.Wait()

	agg := ClusterDiskUsage{Nodes: results, FetchedAt: time.Now()}
	for _, n := range results {
		agg.TotalBytes += n.TotalBytes
		agg.UsedBytes += n.UsedBytes
		agg.FreeBytes += n.FreeBytes
	}

	diskUsageCacheMu.Lock()
	diskUsageCache[key] = diskUsageCacheEntry{val: agg, at: time.Now()}
	diskUsageCacheMu.Unlock()
	return agg, nil
}

func fetchOne(ctx context.Context, addr string) NodeDiskUsage {
	out := NodeDiskUsage{Server: addr}
	url := normalizeStatusURL(addr)
	reqCtx, cancel := context.WithTimeout(ctx, diskStatusTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, url, nil)
	if err != nil {
		out.Error = err.Error()
		return out
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		out.Error = err.Error()
		return out
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		out.Error = fmt.Sprintf("http %d", resp.StatusCode)
		return out
	}
	var s VolumeServerStatus
	if err := json.NewDecoder(resp.Body).Decode(&s); err != nil {
		out.Error = fmt.Sprintf("decode: %v", err)
		return out
	}
	out.Reachable = true
	for _, d := range s.DiskStatuses {
		out.TotalBytes += d.All
		out.UsedBytes += d.Used
		out.FreeBytes += d.Free
		if d.Dir != "" {
			out.Dirs = append(out.Dirs, d.Dir)
		}
	}
	return out
}

// normalizeStatusURL accepts "host:port" or "http://host:port" and
// returns the full /status URL. DataNode.Id from master topology is
// already in the "host:port" form, so the common path is one strings.HasPrefix
// check + concatenation.
func normalizeStatusURL(addr string) string {
	if strings.HasPrefix(addr, "http://") || strings.HasPrefix(addr, "https://") {
		return strings.TrimRight(addr, "/") + "/status"
	}
	return "http://" + addr + "/status"
}
