package api

import (
	"context"
	"sync"
	"time"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/seaweed"
)

// volumeFetchCache memoises ListVolumesShellAt per master for a short TTL.
// The web console hits /api/v1/volumes whenever the operator opens the
// volumes tab or the dashboard, and each call shells out to `weed shell
// volume.list` against every enabled cluster master. A `weed` subprocess
// invocation costs ~1-2s; without caching every page nav would pay that.
//
// 5s TTL covers rapid page navigation while still showing fresh data
// when the operator deliberately hits Refresh. We use shell instead of
// gRPC because the master gRPC interface drifts across SeaweedFS
// versions; running each cluster's own `weed` binary (per
// cluster.weed_bin_path) avoids that mismatch entirely.
const volumeFetchTTL = 5 * time.Second

// volumeFetchDeadline caps the time the UI is willing to wait for a single
// `weed shell volume.list` round-trip. Long enough for a large cluster's
// volume list to come back, short enough that an unreachable master or
// stuck shell surfaces as an error in the page instead of a spinning
// request. The preflight probe inside the seaweed client already covers
// the "TCP can't connect" case in ~4s; this budget is for "TCP connects
// but shell hangs / master GC pause / slow disk".
const volumeFetchDeadline = 15 * time.Second

type volumeFetch struct {
	vols      []seaweed.VolumeInfo
	nodes     []seaweed.NodeDiskStats
	err       error
	fetchedAt time.Time
}

var (
	volumeFetchMu    sync.Mutex
	volumeFetchByKey = map[string]*volumeFetch{}
	// inflight prevents thundering herds: when two requests want the same
	// master and the cache is cold, the second waits on the first instead
	// of issuing a duplicate gRPC call.
	volumeFetchInflight = map[string]chan struct{}{}
)

// fetchClusterVolumes returns the cached (vols, nodes, err) for `master`
// if the entry is younger than volumeFetchTTL, otherwise it shells out
// to `weed shell volume.list` (using the cluster's own weed binary when
// configured) and stores the result. A single shell call produces both
// the volume rows and the per-disk node stats.
func fetchClusterVolumes(ctx context.Context, sw *seaweed.Client, master, binPath string) ([]seaweed.VolumeInfo, []seaweed.NodeDiskStats, error) {
	key := master + "|" + binPath
	now := time.Now()

	volumeFetchMu.Lock()
	if cached, ok := volumeFetchByKey[key]; ok && now.Sub(cached.fetchedAt) < volumeFetchTTL {
		volumeFetchMu.Unlock()
		return cached.vols, cached.nodes, cached.err
	}
	if wait, ok := volumeFetchInflight[key]; ok {
		volumeFetchMu.Unlock()
		select {
		case <-wait:
		case <-ctx.Done():
			return nil, nil, ctx.Err()
		}
		volumeFetchMu.Lock()
		if cached, ok := volumeFetchByKey[key]; ok {
			volumeFetchMu.Unlock()
			return cached.vols, cached.nodes, cached.err
		}
		volumeFetchMu.Unlock()
	} else {
		done := make(chan struct{})
		volumeFetchInflight[key] = done
		volumeFetchMu.Unlock()
		defer func() {
			volumeFetchMu.Lock()
			delete(volumeFetchInflight, key)
			volumeFetchMu.Unlock()
			close(done)
		}()
	}

	fetchCtx, cancel := context.WithTimeout(ctx, volumeFetchDeadline)
	defer cancel()
	vols, nodes, err := sw.ListVolumesShellAt(fetchCtx, master, binPath)

	entry := &volumeFetch{vols: vols, nodes: nodes, err: err, fetchedAt: time.Now()}
	volumeFetchMu.Lock()
	volumeFetchByKey[key] = entry
	volumeFetchMu.Unlock()
	return vols, nodes, err
}
