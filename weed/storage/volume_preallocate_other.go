//go:build !linux && !darwin && !freebsd && !dragonfly && !netbsd && !openbsd

package storage

import "fmt"

// Stub for non-POSIX; composition layer falls back to configured on error.
func currentDatAllocationShape(v *Volume) (logicalSize int64, allocatedBytes uint64, err error) {
	return 0, 0, fmt.Errorf("allocation shape not available on this platform")
}
