//go:build linux || darwin || freebsd || dragonfly || netbsd || openbsd

package weed_server

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"syscall"

	"github.com/seaweedfs/seaweedfs/weed/glog"
	"github.com/seaweedfs/seaweedfs/weed/pb/volume_server_pb"
	"github.com/seaweedfs/seaweedfs/weed/storage/needle"
)

// VolumeShrinkPreallocated reclaims disk blocks reserved by FALLOC_FL_KEEP_SIZE
// preallocation in a volume's .dat file by sparse-copying the live byte range
// [0, st_size) into a fresh file and atomically renaming over the original.
//
// This implementation depends on POSIX semantics (st_blocks, fsync of a
// directory inode, atomic rename over an existing file). A separate stub
// returns Unimplemented on platforms without those guarantees.
//
// Pre-conditions enforced by this handler:
//   - the volume must already be readonly (mark it via volume.mark first)
//   - the volume must not be in compaction (vacuum) at the same time
//
// Internal flow:
//
//	stat -> probe reclaim -> atomically claim shrink flag + verify readonly ->
//	Unmount -> sparse copy -> fsync file -> rename -> fsync dir -> Mount.
//
// On any error after Unmount, the handler attempts to restore mount state
// before returning so the caller can retry safely.
func (vs *VolumeServer) VolumeShrinkPreallocated(
	ctx context.Context,
	req *volume_server_pb.VolumeShrinkPreallocatedRequest,
) (*volume_server_pb.VolumeShrinkPreallocatedResponse, error) {

	resp := &volume_server_pb.VolumeShrinkPreallocatedResponse{}

	if err := vs.CheckMaintenanceMode(); err != nil {
		return resp, err
	}
	// ctx is honored only at safe early-abort points (before unmount). Once we
	// have unmounted the volume, the unmount/copy/rename/mount sequence runs
	// to completion regardless of ctx so the volume is never left unmounted.
	if err := ctx.Err(); err != nil {
		return resp, err
	}

	vid := needle.VolumeId(req.VolumeId)
	v := vs.store.GetVolume(vid)
	if v == nil {
		return resp, fmt.Errorf("volume %d not found", req.VolumeId)
	}
	// Cheap pre-check used only for early skip / nicer error before stat. The
	// authoritative check happens atomically inside TryEnterShrinkReadonly.
	if !v.IsReadOnly() {
		return resp, fmt.Errorf("volume %d is not readonly; mark it readonly first", req.VolumeId)
	}

	datPath := v.FileName(".dat")
	logical, allocatedBefore, mode, err := statSizes(datPath)
	if err != nil {
		return resp, fmt.Errorf("stat %s: %w", datPath, err)
	}
	resp.LogicalSize = uint64(logical)
	resp.AllocatedBytesBefore = allocatedBefore
	resp.AllocatedBytesAfter = allocatedBefore

	reclaimable := uint64(0)
	if allocatedBefore > uint64(logical) {
		reclaimable = allocatedBefore - uint64(logical)
	}
	if reclaimable < req.MinReclaimBytes {
		resp.SkipReason = fmt.Sprintf("reclaimable %d below threshold %d", reclaimable, req.MinReclaimBytes)
		return resp, nil
	}
	if req.DryRun {
		resp.SkipReason = "dry-run"
		resp.ReclaimedBytes = reclaimable
		return resp, nil
	}

	// Atomic claim: under the volume's noWriteLock, verify the volume is
	// explicitly readonly AND no shrink is already running, then set the
	// shrink flag. MarkVolumeWritable acquires the same lock and refuses
	// while the flag is set, so the readonly invariant holds from here
	// through ReleaseShrink without any TOCTOU window.
	if ok, reason := v.TryEnterShrinkReadonly(); !ok {
		resp.SkipReason = reason
		return resp, nil
	}
	defer v.ReleaseShrink()

	// Last cancellation checkpoint before the side-effecting sequence.
	if err := ctx.Err(); err != nil {
		return resp, err
	}

	if err := vs.store.UnmountVolume(vid); err != nil {
		return resp, fmt.Errorf("unmount %d: %w", req.VolumeId, err)
	}
	remounted := false
	defer func() {
		if !remounted {
			if mErr := vs.store.MountVolume(vid); mErr != nil {
				glog.Errorf("remount volume %d after shrink failure: %v", req.VolumeId, mErr)
			}
		}
	}()

	tmpPath := datPath + ".shrink.tmp"
	// stale tmp from a previous crash should not block us
	_ = os.Remove(tmpPath)

	if err := sparseCopyFile(datPath, tmpPath, logical, mode); err != nil {
		_ = os.Remove(tmpPath)
		return resp, fmt.Errorf("sparse copy: %w", err)
	}

	if err := os.Rename(tmpPath, datPath); err != nil {
		_ = os.Remove(tmpPath)
		return resp, fmt.Errorf("rename tmp into place: %w", err)
	}

	// Directory fsync makes the rename durable on POSIX filesystems. If it
	// fails the new layout is still in place and readable; we surface this as
	// a warning so the caller knows durability across a kernel crash is not
	// guaranteed and can decide whether to retry.
	if err := fsyncDir(filepath.Dir(datPath)); err != nil {
		resp.DurabilityWarning = fmt.Sprintf("fsync parent dir failed: %v", err)
		glog.Errorf("fsync dir %s after shrink: %v", filepath.Dir(datPath), err)
	}

	if err := vs.store.MountVolume(vid); err != nil {
		return resp, fmt.Errorf("remount %d after shrink: %w", req.VolumeId, err)
	}
	remounted = true

	logicalAfter, allocatedAfter, _, err := statSizes(datPath)
	if err != nil {
		// volume is mounted, so this is informational only.
		glog.Errorf("post-shrink stat %s: %v", datPath, err)
		resp.Shrunk = true
		return resp, nil
	}
	resp.LogicalSize = uint64(logicalAfter)
	resp.AllocatedBytesAfter = allocatedAfter
	if allocatedBefore > allocatedAfter {
		resp.ReclaimedBytes = allocatedBefore - allocatedAfter
	}
	resp.Shrunk = true
	glog.V(0).Infof("volume %d shrink: logical=%d allocated %d -> %d reclaimed=%d warn=%q",
		req.VolumeId, logicalAfter, allocatedBefore, allocatedAfter, resp.ReclaimedBytes, resp.DurabilityWarning)
	return resp, nil
}

// statSizes returns the file's logical size, allocated byte count
// (st_blocks * 512), and permission bits. The block count comes from the
// kernel and reflects FALLOC_FL_KEEP_SIZE preallocations, not just bytes
// written.
func statSizes(path string) (logical int64, allocatedBytes uint64, mode os.FileMode, err error) {
	st, err := os.Stat(path)
	if err != nil {
		return 0, 0, 0, err
	}
	logical = st.Size()
	mode = st.Mode().Perm()
	if sys, ok := st.Sys().(*syscall.Stat_t); ok {
		// st_blocks reports 512-byte units on linux/darwin/bsd
		allocatedBytes = uint64(sys.Blocks) * 512
	} else {
		allocatedBytes = uint64(logical)
	}
	return logical, allocatedBytes, mode, nil
}

// sparseCopyFile copies the first `size` bytes from src to dst. dst is created
// fresh with O_EXCL and without preallocation, so the kernel allocates blocks
// on demand. The destination's permission bits are inherited from `mode` so
// the caller-side rename does not silently relax perms.
func sparseCopyFile(src, dst string, size int64, mode os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	if mode == 0 {
		mode = 0644
	}
	out, err := os.OpenFile(dst, os.O_RDWR|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	closed := false
	defer func() {
		if !closed {
			_ = out.Close()
		}
	}()

	if size > 0 {
		if _, err := io.CopyN(out, in, size); err != nil {
			return fmt.Errorf("copy: %w", err)
		}
	}
	if err := out.Sync(); err != nil {
		return fmt.Errorf("fsync %s: %w", dst, err)
	}
	if err := out.Close(); err != nil {
		closed = true
		return fmt.Errorf("close %s: %w", dst, err)
	}
	closed = true
	return nil
}

// fsyncDir makes a rename durable on POSIX filesystems by fsyncing the parent
// directory inode.
func fsyncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}
