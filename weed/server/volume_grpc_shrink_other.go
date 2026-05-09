//go:build !linux && !darwin && !freebsd && !dragonfly && !netbsd && !openbsd

package weed_server

import (
	"context"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/seaweedfs/seaweedfs/weed/pb/volume_server_pb"
)

// VolumeShrinkPreallocated is intentionally not implemented on this platform.
// The implementation relies on POSIX semantics that are unavailable or behave
// differently here: st_blocks for measuring preallocated tail space, fsync of
// a directory inode, and atomic rename over an existing open file. Returning
// codes.Unimplemented lets clients distinguish "platform does not support
// this" from a routine RPC error.
func (vs *VolumeServer) VolumeShrinkPreallocated(
	_ context.Context,
	_ *volume_server_pb.VolumeShrinkPreallocatedRequest,
) (*volume_server_pb.VolumeShrinkPreallocatedResponse, error) {
	return &volume_server_pb.VolumeShrinkPreallocatedResponse{},
		status.Error(codes.Unimplemented, "volume shrink is only supported on POSIX platforms (linux/darwin/*bsd)")
}
