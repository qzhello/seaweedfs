package storage

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/seaweedfs/seaweedfs/weed/storage/needle"
)

func TestDecideEffectivePreallocate(t *testing.T) {
	const cfg30G = int64(30 * 1024 * 1024 * 1024)

	cases := []struct {
		name       string
		configured int64
		logical    int64
		allocated  uint64
		want       int64
	}{
		{
			name:       "globally disabled",
			configured: 0,
			logical:    1 << 30,
			allocated:  1 << 30,
			want:       0,
		},
		{
			name:       "negative configured treated as disabled",
			configured: -1,
			logical:    1 << 30,
			allocated:  30 << 30,
			want:       0,
		},
		{
			name:       "still preallocated keeps preallocation",
			configured: cfg30G,
			logical:    5 << 30,
			allocated:  30 << 30,
			want:       cfg30G,
		},
		{
			name:       "shrunk volume stays non-preallocated",
			configured: cfg30G,
			logical:    5 << 30,
			allocated:  uint64(5<<30) + 4*1024*1024, // 4 MiB extra (block rounding)
			want:       0,
		},
		{
			name:       "right at the slack threshold stays non-preallocated",
			configured: cfg30G,
			logical:    5 << 30,
			allocated:  uint64(5<<30) + uint64(NonPreallocatedSlackBytes),
			want:       0,
		},
		{
			name:       "just above the slack threshold preserves preallocation",
			configured: cfg30G,
			logical:    5 << 30,
			allocated:  uint64(5<<30) + uint64(NonPreallocatedSlackBytes) + 1,
			want:       cfg30G,
		},
		{
			name:       "empty volume non-preallocated",
			configured: cfg30G,
			logical:    0,
			allocated:  0,
			want:       0,
		},
		{
			name:       "empty volume still preallocated",
			configured: cfg30G,
			logical:    0,
			allocated:  30 << 30,
			want:       cfg30G,
		},
		{
			name:       "allocated smaller than logical falls back to configured",
			configured: cfg30G,
			logical:    1 << 30,
			allocated:  1 << 20,
			want:       cfg30G,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := decideEffectivePreallocate(tc.configured, tc.logical, tc.allocated)
			if got != tc.want {
				t.Errorf("decideEffectivePreallocate(cfg=%d, logical=%d, allocated=%d) = %d, want %d",
					tc.configured, tc.logical, tc.allocated, got, tc.want)
			}
		})
	}
}

func TestEffectivePreallocateForVolumeDat_Composition(t *testing.T) {
	const cfg = int64(30 * 1024 * 1024 * 1024)

	type shape struct {
		logical   int64
		allocated uint64
		err       error
	}

	cases := []struct {
		name       string
		configured int64
		shape      shape
		want       int64
	}{
		{
			name:       "cfg=0 short-circuits before stat",
			configured: 0,
			// shape would say preallocated, but cfg=0 wins
			shape: shape{logical: 5 << 30, allocated: 30 << 30},
			want:  0,
		},
		{
			name:       "preallocated shape preserves configured (the main positive branch)",
			configured: cfg,
			shape:      shape{logical: 5 << 30, allocated: 30 << 30},
			want:       cfg,
		},
		{
			name:       "shrunk shape returns 0",
			configured: cfg,
			shape:      shape{logical: 5 << 30, allocated: uint64(5<<30) + 4*1024*1024},
			want:       0,
		},
		{
			name:       "stat error falls back to configured",
			configured: cfg,
			shape:      shape{err: os.ErrNotExist},
			want:       cfg,
		},
		{
			name:       "allocated < logical falls back to configured",
			configured: cfg,
			shape:      shape{logical: 1 << 30, allocated: 1 << 20},
			want:       cfg,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			restore := statShape
			t.Cleanup(func() { statShape = restore })
			statShape = func(v *Volume) (int64, uint64, error) {
				return tc.shape.logical, tc.shape.allocated, tc.shape.err
			}

			v := &Volume{Id: needle.VolumeId(1)}
			got := effectivePreallocateForVolumeDat(v, tc.configured)
			if got != tc.want {
				t.Errorf("effectivePreallocateForVolumeDat = %d, want %d", got, tc.want)
			}
		})
	}
}

// Smoke-tests the real POSIX stat path against an on-disk file.
func TestEffectivePreallocateForVolumeDat_RealFile(t *testing.T) {
	switch runtime.GOOS {
	case "linux", "darwin", "freebsd", "dragonfly", "netbsd", "openbsd":
	default:
		t.Skipf("currentDatAllocationShape unimplemented on %s", runtime.GOOS)
	}

	tmp := t.TempDir()
	v := &Volume{Id: needle.VolumeId(1), dir: tmp, dirIdx: tmp}

	// 4 MiB dense file: extra allocated < 64 MiB slack -> 0.
	if err := os.WriteFile(filepath.Join(tmp, "1.dat"), make([]byte, 4*1024*1024), 0644); err != nil {
		t.Fatalf("write dat: %v", err)
	}
	const cfg = int64(30 * 1024 * 1024 * 1024)
	if got := effectivePreallocateForVolumeDat(v, cfg); got != 0 {
		t.Errorf("dense file: got %d, want 0", got)
	}
}

// Tests the shared helper. Does NOT prove CompactVolume / CompactVolumeFiles
// actually call it — that contract is enforced only by code review.
func TestCompactPreallocateBytes_SharedHelper(t *testing.T) {
	const cfg = int64(30 * 1024 * 1024 * 1024)

	cases := []struct {
		name  string
		shape func() (int64, uint64, error)
		want  int64
	}{
		{
			name: "preallocated shape -> configured",
			shape: func() (int64, uint64, error) {
				return 5 << 30, 30 << 30, nil
			},
			want: cfg,
		},
		{
			name: "shrunk shape -> 0",
			shape: func() (int64, uint64, error) {
				return 5 << 30, uint64(5<<30) + 4*1024*1024, nil
			},
			want: 0,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			restore := statShape
			t.Cleanup(func() { statShape = restore })
			statShape = func(_ *Volume) (int64, uint64, error) {
				return tc.shape()
			}

			v := &Volume{Id: needle.VolumeId(1)}
			if got := compactPreallocateBytes(v, cfg); got != tc.want {
				t.Errorf("compactPreallocateBytes = %d, want %d", got, tc.want)
			}
		})
	}
}
