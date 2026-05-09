package storage

import (
	"github.com/seaweedfs/seaweedfs/weed/glog"
)

// NonPreallocatedSlackBytes tolerates fs block rounding / metadata when
// deciding whether a .dat is currently non-preallocated.
const NonPreallocatedSlackBytes int64 = 64 * 1024 * 1024

// decideEffectivePreallocate picks the preallocate value a rebuild should
// use, inheriting the current .dat's allocation shape. Pure for testing.
func decideEffectivePreallocate(configuredPreallocate int64, logicalSize int64, allocatedBytes uint64) int64 {
	if configuredPreallocate <= 0 {
		return 0
	}
	// allocated < logical can come from true sparse / fs compression / dedupe;
	// fall back to configured rather than misclassify.
	if int64(allocatedBytes) < logicalSize {
		return configuredPreallocate
	}
	if int64(allocatedBytes)-logicalSize <= NonPreallocatedSlackBytes {
		return 0
	}
	return configuredPreallocate
}

// statShape is overridable in tests so we can drive every composition branch
// without manufacturing real allocated bytes via fallocate.
var statShape = currentDatAllocationShape

func effectivePreallocateForVolumeDat(v *Volume, configuredPreallocate int64) int64 {
	if configuredPreallocate <= 0 {
		return 0
	}
	logicalSize, allocatedBytes, err := statShape(v)
	if err != nil {
		glog.Warningf("volume %d preallocate decision: stat failed (%v); fall back to configured=%d",
			v.Id, err, configuredPreallocate)
		return configuredPreallocate
	}
	if int64(allocatedBytes) < logicalSize {
		glog.Warningf("volume %d preallocate decision: allocated=%d < logical=%d; fall back to configured=%d",
			v.Id, allocatedBytes, logicalSize, configuredPreallocate)
		return configuredPreallocate
	}
	effective := decideEffectivePreallocate(configuredPreallocate, logicalSize, allocatedBytes)
	glog.V(1).Infof("volume %d preallocate decision: configured=%d logical=%d allocated=%d effective=%d",
		v.Id, configuredPreallocate, logicalSize, allocatedBytes, effective)
	return effective
}

// compactPreallocateBytes is the named decision shared by CompactVolume and
// CompactVolumeFiles. Both call sites must use it; that contract is held by
// code review, not by tests.
func compactPreallocateBytes(v *Volume, configuredPreallocate int64) int64 {
	return effectivePreallocateForVolumeDat(v, configuredPreallocate)
}
