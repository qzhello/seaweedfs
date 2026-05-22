// Package seaweed wraps the master / volume gRPC stubs already shipped with
// SeaweedFS, so the controller never has to shell out to `weed shell`.
package seaweed

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/seaweedfs/seaweedfs/weed/pb/master_pb"
	"github.com/seaweedfs/seaweedfs/weed/pb/volume_server_pb"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

// toGrpcAddr applies the SeaweedFS convention "gRPC port = HTTP port + 10000".
// Operators configure clusters using the HTTP port they're already familiar
// with; the controller transparently dials the gRPC port. Pass-through if the
// addr can't be parsed (already a gRPC port, IPv6 oddity, etc).
func toGrpcAddr(addr string) string {
	idx := strings.LastIndex(addr, ":")
	if idx < 0 {
		return addr
	}
	host, portStr := addr[:idx], addr[idx+1:]
	port, err := strconv.Atoi(portStr)
	if err != nil {
		return addr
	}
	// Already a gRPC port? SeaweedFS gRPC convention pushes them >= 18000.
	// Don't double-add when caller passed the gRPC port directly.
	if port >= 18000 {
		return addr
	}
	return fmt.Sprintf("%s:%d", host, port+10000)
}

type Client struct {
	masterAddr  string
	dialTimeout time.Duration
}

type MasterStatusSnapshot struct {
	IsLeader bool
	Leader   string
	Peers    []string
}

type MasterRaftServer struct {
	Address  string
	Suffrage string
	IsLeader bool
}

func New(masterAddr string, dialTimeout time.Duration) *Client {
	if dialTimeout == 0 {
		dialTimeout = 5 * time.Second
	}
	return &Client{masterAddr: masterAddr, dialTimeout: dialTimeout}
}

func (c *Client) dial(ctx context.Context, addr string) (*grpc.ClientConn, error) {
	grpcAddr := toGrpcAddr(addr)
	dctx, cancel := context.WithTimeout(ctx, c.dialTimeout)
	defer cancel()
	conn, err := grpc.DialContext(dctx, grpcAddr,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithBlock())
	if err != nil {
		return nil, fmt.Errorf("dial %s: %w", grpcAddr, err)
	}
	return conn, nil
}

func (c *Client) FetchMasterStatus(ctx context.Context, addr string) (MasterStatusSnapshot, time.Duration, error) {
	type clusterStatusResponse struct {
		IsLeader bool     `json:"IsLeader"`
		Leader   string   `json:"Leader"`
		Peers    []string `json:"Peers"`
	}

	var payload clusterStatusResponse
	latency, err := c.fetchJSON(ctx, addr, "/cluster/status", &payload)
	if err != nil {
		return MasterStatusSnapshot{}, latency, err
	}
	return MasterStatusSnapshot{
		IsLeader: payload.IsLeader,
		Leader:   strings.TrimSpace(payload.Leader),
		Peers:    payload.Peers,
	}, latency, nil
}

func (c *Client) FetchMasterMetrics(ctx context.Context, addr string) (string, time.Duration, error) {
	body, latency, err := c.fetchRaw(ctx, addr, "/metrics")
	if err != nil {
		return "", latency, err
	}
	return string(body), latency, nil
}

// FilerNode is one filer row returned by ListClusterNodes(ClientType=filer).
// The fields mirror master_pb.ListClusterNodesResponse_ClusterNode so the
// rest of the controller never depends on the proto type directly.
type FilerNode struct {
	Address     string `json:"address"`
	Version     string `json:"version,omitempty"`
	DataCenter  string `json:"data_center,omitempty"`
	Rack        string `json:"rack,omitempty"`
	CreatedAtNs int64  `json:"created_at_ns,omitempty"`
}

// ListFilers asks the master for the cluster's registered filers. Returns
// an empty slice (not nil) when the cluster has no filers so the JSON
// payload is a stable shape.
func (c *Client) ListFilers(ctx context.Context, masterAddr string) ([]FilerNode, error) {
	addr := masterAddr
	if addr == "" {
		addr = c.masterAddr
	}
	conn, err := c.dial(ctx, addr)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	resp, err := master_pb.NewSeaweedClient(conn).ListClusterNodes(ctx, &master_pb.ListClusterNodesRequest{
		ClientType: "filer",
	})
	if err != nil {
		return nil, fmt.Errorf("ListClusterNodes(filer): %w", err)
	}
	out := make([]FilerNode, 0, len(resp.ClusterNodes))
	for _, n := range resp.ClusterNodes {
		if n == nil {
			continue
		}
		out = append(out, FilerNode{
			Address:     n.Address,
			Version:     n.Version,
			DataCenter:  n.DataCenter,
			Rack:        n.Rack,
			CreatedAtNs: n.CreatedAtNs,
		})
	}
	return out, nil
}

// LockProbeOutcome reports whether the master admin lock could be leased.
// The probe leases the named lock for a microsecond and then releases it,
// so it never actually keeps the lock — it just learns the holder.
type LockProbeOutcome struct {
	Acquired    bool   // true if we managed to lease (and immediately released)
	Held        bool   // true if a different client holds the lock
	Holder      string // parsed lastClient from "already locked by X" error
	NotLeader   bool   // true if the addr isn't the raft leader
	RawError    string // original error string when not Acquired
	LockTsNs    int64  // lock timestamp returned by the master (when acquired)
}

// ProbeMasterAdminLock dials the master, attempts to lease lockName, and
// releases immediately on success. The call mirrors what `weed shell` does
// but with a one-shot deadline so a held lock surfaces fast.
func (c *Client) ProbeMasterAdminLock(ctx context.Context, addr, lockName, clientName string) (LockProbeOutcome, time.Duration, error) {
	start := time.Now()
	conn, err := c.dial(ctx, addr)
	if err != nil {
		return LockProbeOutcome{RawError: err.Error()}, time.Since(start), err
	}
	defer conn.Close()

	client := master_pb.NewSeaweedClient(conn)
	resp, err := client.LeaseAdminToken(ctx, &master_pb.LeaseAdminTokenRequest{
		LockName:   lockName,
		ClientName: clientName,
		Message:    "tiering-controller lock probe",
	})
	latency := time.Since(start)
	if err != nil {
		outcome := LockProbeOutcome{RawError: err.Error()}
		msg := err.Error()
		if holder, ok := parseAlreadyLockedHolder(msg); ok {
			outcome.Held = true
			outcome.Holder = holder
		}
		if strings.Contains(msg, "NotLeader") || strings.Contains(msg, "not leader") || strings.Contains(msg, "not the leader") {
			outcome.NotLeader = true
		}
		return outcome, latency, err
	}

	// Best-effort release so the master forgets us immediately. Use a fresh
	// short context in case ctx is about to expire — we still want to free
	// the token we just obtained.
	relCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, _ = client.ReleaseAdminToken(relCtx, &master_pb.ReleaseAdminTokenRequest{
		PreviousToken:    resp.Token,
		PreviousLockTime: resp.LockTsNs,
		LockName:         lockName,
	})

	return LockProbeOutcome{Acquired: true, LockTsNs: resp.LockTsNs}, latency, nil
}

// parseAlreadyLockedHolder extracts the "X" from `already locked by X: ...`
// errors produced by MasterServer.LeaseAdminToken. The format is stable and
// is the only structured carrier of the lock holder identity over gRPC.
func parseAlreadyLockedHolder(msg string) (string, bool) {
	const marker = "already locked by "
	idx := strings.Index(msg, marker)
	if idx < 0 {
		return "", false
	}
	rest := msg[idx+len(marker):]
	end := len(rest)
	if i := strings.Index(rest, ":"); i >= 0 {
		end = i
	}
	holder := strings.TrimSpace(rest[:end])
	if holder == "" {
		return "", false
	}
	return holder, true
}

func (c *Client) FetchMasterRaftServers(ctx context.Context, addr string) ([]MasterRaftServer, time.Duration, error) {
	start := time.Now()
	conn, err := c.dial(ctx, addr)
	if err != nil {
		return nil, time.Since(start), err
	}
	defer conn.Close()

	resp, err := master_pb.NewSeaweedClient(conn).RaftListClusterServers(ctx, &master_pb.RaftListClusterServersRequest{})
	latency := time.Since(start)
	if err != nil {
		return nil, latency, fmt.Errorf("RaftListClusterServers: %w", err)
	}

	out := make([]MasterRaftServer, 0, len(resp.ClusterServers))
	for _, server := range resp.ClusterServers {
		if server == nil {
			continue
		}
		address := strings.TrimSpace(server.Id)
		if trimmed := strings.TrimSpace(server.Address); trimmed != "" {
			address = grpcToHTTPAddr(trimmed)
		}
		out = append(out, MasterRaftServer{
			Address:  address,
			Suffrage: strings.TrimSpace(server.Suffrage),
			IsLeader: server.IsLeader,
		})
	}
	return out, latency, nil
}

// VolumeInfo is a flattened view of master_pb.VolumeInformationMessage,
// so the rest of the controller doesn't depend on the proto type directly.
//
// One row per (volume, node). For normal volumes Size/FileCount/... carry
// per-replica figures. For EC volumes IsEC=true, Shards lists the shard
// indices this node holds (subset of 0..13 for the default 10+4 layout),
// ShardSizes holds the byte size of each listed shard, and Size is the sum
// of ShardSizes — so existing byte-aware UIs do not need to special-case EC.
type VolumeInfo struct {
	ID                uint32
	Collection        string
	Size              uint64
	FileCount         uint64
	DeleteCount       uint64
	DeletedBytes      uint64
	ReadOnly          bool
	ReplicaPlace      uint32
	DiskType          string
	Server            string
	Rack              string
	DataCenter        string
	ModifiedAtSec     int64
	RemoteStorageName string
	RemoteStorageKey  string

	// EC fields. IsEC=false for normal volumes (the zero value, so existing
	// callers keep working unchanged).
	IsEC       bool     `json:"IsEC"`
	Shards     []int    `json:"Shards,omitempty"`
	ShardSizes []uint64 `json:"ShardSizes,omitempty"`
}

// ListVolumes pulls the topology from the default master.
func (c *Client) ListVolumes(ctx context.Context) ([]VolumeInfo, error) {
	return c.ListVolumesAt(ctx, "")
}

// NodeDiskStats aggregates a single storage node's slot/byte usage as
// reported by the master topology. Useful for disk-usage dashboards.
type NodeDiskStats struct {
	Server            string `json:"server"`
	Rack              string `json:"rack"`
	DataCenter        string `json:"data_center"`
	DiskType          string `json:"disk_type"`
	VolumeCount       int64  `json:"volume_count"`
	MaxVolumeCount    int64  `json:"max_volume_count"`
	FreeVolumeCount   int64  `json:"free_volume_count"`
	ActiveVolumeCount int64  `json:"active_volume_count"`
	RemoteVolumeCount int64  `json:"remote_volume_count"`
	UsedBytes         uint64 `json:"used_bytes"`
}

// volumeList runs the master VolumeList gRPC, transparently following a
// Raft leadership redirect. SeaweedFS masters form a Raft group and only
// the leader answers VolumeList — a follower rejects it with "Not
// current leader".
//
// When that happens we ask the contacted master for the Raft cluster via
// RaftListClusterServers (a gRPC call every master answers, follower
// included, and which flags the leader) and retry against the leader.
// The master has no /cluster/status HTTP endpoint, so the gRPC route is
// the only reliable way to discover the leader from a follower.
func (c *Client) volumeList(ctx context.Context, addr string) (*master_pb.VolumeListResponse, error) {
	resp, err := c.volumeListOnce(ctx, addr)
	if err == nil || !isNotLeaderError(err) {
		return resp, err
	}

	// addr is a follower — discover the Raft cluster from it.
	servers, _, rerr := c.FetchMasterRaftServers(ctx, addr)
	if rerr != nil || len(servers) == 0 {
		return nil, err // can't discover the leader — surface the original error
	}

	// Prefer the explicitly-flagged leader.
	leader := ""
	for _, s := range servers {
		if s.IsLeader && s.Address != "" {
			leader = s.Address
			break
		}
	}
	if leader != "" && leader != addr {
		if r, e := c.volumeListOnce(ctx, leader); e == nil {
			return r, nil
		}
	}

	// No flagged leader (mid-election) or the flagged one still rejected:
	// fall back to trying every other master until one answers.
	for _, s := range servers {
		if s.Address == "" || s.Address == addr || s.Address == leader {
			continue
		}
		if r, e := c.volumeListOnce(ctx, s.Address); e == nil {
			return r, nil
		}
	}
	return nil, err // exhausted every master — surface the original error
}

func (c *Client) volumeListOnce(ctx context.Context, addr string) (*master_pb.VolumeListResponse, error) {
	conn, err := c.dial(ctx, addr)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	resp, err := master_pb.NewSeaweedClient(conn).VolumeList(ctx, &master_pb.VolumeListRequest{})
	if err != nil {
		return nil, fmt.Errorf("VolumeList: %w", err)
	}
	return resp, nil
}

// isNotLeaderError reports whether a master gRPC error is a Raft
// "you contacted a follower" rejection.
func isNotLeaderError(err error) bool {
	if err == nil {
		return false
	}
	s := strings.ToLower(err.Error())
	return strings.Contains(s, "not current leader") ||
		strings.Contains(s, "not the leader") ||
		strings.Contains(s, "notleader")
}

// ListNodesAt walks the master topology and returns per-disk node stats,
// merging disks of the same type on the same server. Multi-cluster aware
// when masterAddr is non-empty.
func (c *Client) ListNodesAt(ctx context.Context, masterAddr string) ([]NodeDiskStats, error) {
	addr := masterAddr
	if addr == "" {
		addr = c.masterAddr
	}
	resp, err := c.volumeList(ctx, addr)
	if err != nil {
		return nil, err
	}
	out := []NodeDiskStats{}
	if resp.TopologyInfo == nil {
		return out, nil
	}
	for _, dc := range resp.TopologyInfo.DataCenterInfos {
		for _, rack := range dc.RackInfos {
			for _, node := range rack.DataNodeInfos {
				for _, disk := range node.DiskInfos {
					var used uint64
					for _, v := range disk.VolumeInfos {
						used += v.Size
					}
					out = append(out, NodeDiskStats{
						Server:            node.Id,
						Rack:              rack.Id,
						DataCenter:        dc.Id,
						DiskType:          disk.Type,
						VolumeCount:       disk.VolumeCount,
						MaxVolumeCount:    disk.MaxVolumeCount,
						FreeVolumeCount:   disk.FreeVolumeCount,
						ActiveVolumeCount: disk.ActiveVolumeCount,
						RemoteVolumeCount: disk.RemoteVolumeCount,
						UsedBytes:         used,
					})
				}
			}
		}
	}
	return out, nil
}

// ListVolumesAt targets a specific master (multi-cluster aware).
func (c *Client) ListVolumesAt(ctx context.Context, masterAddr string) ([]VolumeInfo, error) {
	addr := masterAddr
	if addr == "" {
		addr = c.masterAddr
	}
	resp, err := c.volumeList(ctx, addr)
	if err != nil {
		return nil, err
	}
	out := []VolumeInfo{}
	if resp.TopologyInfo == nil {
		return out, nil
	}
	for _, dc := range resp.TopologyInfo.DataCenterInfos {
		for _, rack := range dc.RackInfos {
			for _, node := range rack.DataNodeInfos {
				for _, disk := range node.DiskInfos {
					for _, v := range disk.VolumeInfos {
						out = append(out, VolumeInfo{
							ID:                v.Id,
							Collection:        v.Collection,
							Size:              v.Size,
							FileCount:         v.FileCount,
							DeleteCount:       v.DeleteCount,
							DeletedBytes:      v.DeletedByteCount,
							ReadOnly:          v.ReadOnly,
							ReplicaPlace:      v.ReplicaPlacement,
							DiskType:          disk.Type,
							Server:            node.Id,
							Rack:              rack.Id,
							DataCenter:        dc.Id,
							ModifiedAtSec:     int64(v.ModifiedAtSecond),
							RemoteStorageName: v.RemoteStorageName,
							RemoteStorageKey:  v.RemoteStorageKey,
						})
					}
					// EC shards on this disk. One row per (volume, node) so
					// the row shape stays uniform with normal volumes; the
					// Shards slice tells you which shard indices live here.
					for _, ec := range disk.EcShardInfos {
						shards := decodeEcIndexBits(ec.EcIndexBits)
						sizes := make([]uint64, 0, len(shards))
						var total uint64
						for i, s := range ec.ShardSizes {
							if i >= len(shards) {
								break
							}
							sz := uint64(0)
							if s > 0 {
								sz = uint64(s)
							}
							sizes = append(sizes, sz)
							total += sz
						}
						out = append(out, VolumeInfo{
							ID:            ec.Id,
							Collection:    ec.Collection,
							Size:          total,
							FileCount:     ec.FileCount,
							DeleteCount:   ec.DeleteCount,
							ReadOnly:      true, // EC volumes are always read-only.
							DiskType:      disk.Type,
							Server:        node.Id,
							Rack:          rack.Id,
							DataCenter:    dc.Id,
							ModifiedAtSec: int64(ec.ExpireAtSec),
							IsEC:          true,
							Shards:        shards,
							ShardSizes:    sizes,
						})
					}
				}
			}
		}
	}
	return out, nil
}

// TierMoveDatToRemote uploads a volume's .dat file to a remote backend.
func (c *Client) TierMoveDatToRemote(ctx context.Context, volumeServer string,
	volumeID uint32, collection, dest string, keepLocalDat bool) error {
	conn, err := c.dial(ctx, volumeServer)
	if err != nil {
		return err
	}
	defer conn.Close()
	stream, err := volume_server_pb.NewVolumeServerClient(conn).
		VolumeTierMoveDatToRemote(ctx, &volume_server_pb.VolumeTierMoveDatToRemoteRequest{
			VolumeId:               volumeID,
			Collection:             collection,
			DestinationBackendName: dest,
			KeepLocalDatFile:       keepLocalDat,
		})
	if err != nil {
		return fmt.Errorf("VolumeTierMoveDatToRemote: %w", err)
	}
	for {
		_, rerr := stream.Recv()
		if rerr != nil {
			break // EOF or transport error
		}
	}
	return nil
}

// TierMoveDatFromRemote downloads a tiered volume back (rollback path).
func (c *Client) TierMoveDatFromRemote(ctx context.Context, volumeServer string,
	volumeID uint32, collection string, keepRemote bool) error {
	conn, err := c.dial(ctx, volumeServer)
	if err != nil {
		return err
	}
	defer conn.Close()
	stream, err := volume_server_pb.NewVolumeServerClient(conn).
		VolumeTierMoveDatFromRemote(ctx, &volume_server_pb.VolumeTierMoveDatFromRemoteRequest{
			VolumeId:          volumeID,
			Collection:        collection,
			KeepRemoteDatFile: keepRemote,
		})
	if err != nil {
		return fmt.Errorf("VolumeTierMoveDatFromRemote: %w", err)
	}
	for {
		_, rerr := stream.Recv()
		if rerr != nil {
			break
		}
	}
	return nil
}

// decodeEcIndexBits returns the sorted shard indices represented by
// EcIndexBits — bit i set means this node holds shard i. The default EC
// layout is 10+4 (14 shards, indices 0..13) but the decoder is generic.
func decodeEcIndexBits(bits uint32) []int {
	shards := make([]int, 0, 14)
	for i := 0; i < 32; i++ {
		if bits&(1<<uint(i)) != 0 {
			shards = append(shards, i)
		}
	}
	return shards
}

func (c *Client) fetchJSON(ctx context.Context, addr, path string, dst any) (time.Duration, error) {
	body, latency, err := c.fetchRaw(ctx, addr, path)
	if err != nil {
		return latency, err
	}
	if err := json.Unmarshal(body, dst); err != nil {
		return latency, fmt.Errorf("decode %s: %w", path, err)
	}
	return latency, nil
}

func (c *Client) fetchRaw(ctx context.Context, addr, path string) ([]byte, time.Duration, error) {
	url := masterHTTPURL(addr, path)
	start := time.Now()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, time.Since(start), err
	}
	resp, err := http.DefaultClient.Do(req)
	latency := time.Since(start)
	if err != nil {
		return nil, latency, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, latency, fmt.Errorf("%s: http %d", path, resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, latency, fmt.Errorf("read %s: %w", path, err)
	}
	return body, latency, nil
}

func masterHTTPURL(addr, path string) string {
	addr = strings.TrimSpace(addr)
	if strings.HasPrefix(addr, "http://") || strings.HasPrefix(addr, "https://") {
		return strings.TrimRight(addr, "/") + path
	}
	return "http://" + strings.TrimRight(addr, "/") + path
}

func grpcToHTTPAddr(addr string) string {
	host, portStr, err := net.SplitHostPort(strings.TrimSpace(addr))
	if err != nil {
		return addr
	}
	port, err := strconv.Atoi(portStr)
	if err != nil || port < 10000 {
		return addr
	}
	return net.JoinHostPort(host, strconv.Itoa(port-10000))
}
