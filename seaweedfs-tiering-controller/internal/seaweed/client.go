// Package seaweed wraps the master / volume gRPC stubs already shipped with
// SeaweedFS, so the controller never has to shell out to `weed shell`.
package seaweed

import (
	"context"
	"fmt"
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

// VolumeInfo is a flattened view of master_pb.VolumeInformationMessage,
// so the rest of the controller doesn't depend on the proto type directly.
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

// ListNodesAt walks the master topology and returns per-disk node stats,
// merging disks of the same type on the same server. Multi-cluster aware
// when masterAddr is non-empty.
func (c *Client) ListNodesAt(ctx context.Context, masterAddr string) ([]NodeDiskStats, error) {
	addr := masterAddr
	if addr == "" {
		addr = c.masterAddr
	}
	conn, err := c.dial(ctx, addr)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	resp, err := master_pb.NewSeaweedClient(conn).VolumeList(ctx, &master_pb.VolumeListRequest{})
	if err != nil {
		return nil, fmt.Errorf("VolumeList: %w", err)
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
	conn, err := c.dial(ctx, addr)
	if err != nil {
		return nil, err
	}
	defer conn.Close()

	resp, err := master_pb.NewSeaweedClient(conn).VolumeList(ctx, &master_pb.VolumeListRequest{})
	if err != nil {
		return nil, fmt.Errorf("VolumeList: %w", err)
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
