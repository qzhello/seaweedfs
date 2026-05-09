//go:build linux || darwin || freebsd || dragonfly || netbsd || openbsd

package storage

import (
	"os"
	"syscall"
)

// Returns logical size and allocated bytes (st_blocks * 512). POSIX only.
func currentDatAllocationShape(v *Volume) (logicalSize int64, allocatedBytes uint64, err error) {
	st, err := os.Stat(v.FileName(".dat"))
	if err != nil {
		return 0, 0, err
	}
	logicalSize = st.Size()
	if sys, ok := st.Sys().(*syscall.Stat_t); ok {
		allocatedBytes = uint64(sys.Blocks) * 512
	} else {
		allocatedBytes = uint64(logicalSize)
	}
	return logicalSize, allocatedBytes, nil
}
