package api

import (
	"reflect"
	"sort"
	"testing"
)

func TestParseECRebuildOutput(t *testing.T) {
	out := `
ec.rebuild
volume 7 collection mybucket has missing shards: [4 11]
would rebuild volume 7
volume 13 has missing shards: [1]
volume 22 cannot be rebuilt, only 8 shards present
`
	sum := parseECRebuildOutput(out)
	if sum.Rebuildable != 2 || sum.Unrecoverable != 1 {
		t.Errorf("counts wrong: %+v", sum)
	}
	// Sort by VolumeID for stable assert.
	sort.Slice(sum.Degraded, func(i, j int) bool {
		return sum.Degraded[i].VolumeID < sum.Degraded[j].VolumeID
	})
	if len(sum.Degraded) != 3 {
		t.Fatalf("want 3 degraded, got %d: %+v", len(sum.Degraded), sum.Degraded)
	}
	v7 := sum.Degraded[0]
	if v7.VolumeID != 7 || v7.Collection != "mybucket" ||
		!reflect.DeepEqual(v7.MissingShards, []int{4, 11}) || !v7.Rebuildable {
		t.Errorf("vol 7 wrong: %+v", v7)
	}
	v22 := sum.Degraded[2]
	if v22.VolumeID != 22 || v22.Rebuildable {
		t.Errorf("vol 22 should be unrecoverable: %+v", v22)
	}
}

func TestParseECRebuildOutput_Empty(t *testing.T) {
	sum := parseECRebuildOutput("ec.rebuild\nno volumes need rebuild\n")
	if len(sum.Degraded) != 0 || sum.Rebuildable != 0 || sum.Unrecoverable != 0 {
		t.Errorf("expected empty summary, got %+v", sum)
	}
}

func TestBuildECEncodeArgs(t *testing.T) {
	t.Run("collection scope", func(t *testing.T) {
		got := buildECEncodeArgs(ecEncodeBody{
			Collection:  "mybucket",
			FullPercent: 95,
			QuietFor:    "1h",
			DiskType:    "hdd",
		}, 0)
		want := []string{"-collection=mybucket", "-fullPercent=95", "-quietFor=1h", "-diskType=hdd"}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("got %v\nwant %v", got, want)
		}
	})

	t.Run("single volume id forwards all params", func(t *testing.T) {
		got := buildECEncodeArgs(ecEncodeBody{
			DiskType: "ssd",
			Force:    true,
		}, 7)
		want := []string{"-volumeId=7", "-diskType=ssd", "-force"}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("got %v\nwant %v", got, want)
		}
	})

	t.Run("rebalance opt-out", func(t *testing.T) {
		no := false
		got := buildECEncodeArgs(ecEncodeBody{
			Collection: "x",
			Rebalance:  &no,
		}, 0)
		want := []string{"-collection=x", "-rebalance=false"}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("got %v\nwant %v", got, want)
		}
	})
}

func TestBuildECEncodeArgs_VolumeKeepsCollectionAndQuiet(t *testing.T) {
	// Regression: previously we stripped -collection / -fullPercent /
	// -quietFor / -sourceDiskType when -volumeId was set. The weed shell
	// accepts those flags either way, and operators want them honoured
	// even in volume-targeted mode — re-asserting the new behaviour here.
	got := buildECEncodeArgs(ecEncodeBody{
		Collection:     "mybucket",
		FullPercent:    90,
		QuietFor:       "30m",
		SourceDiskType: "ssd",
		DiskType:       "hdd",
		Verbose:        true,
	}, 42)
	want := []string{
		"-volumeId=42",
		"-collection=mybucket",
		"-fullPercent=90",
		"-quietFor=30m",
		"-sourceDiskType=ssd",
		"-diskType=hdd",
		"-verbose",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %v\nwant %v", got, want)
	}
}

func TestBuildECRebuildArgs(t *testing.T) {
	t.Run("dry-run defaults", func(t *testing.T) {
		got := buildECRebuildArgs(ecRebuildBody{})
		want := []string{"-collection=EACH_COLLECTION"}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("got %v want %v", got, want)
		}
	})
	t.Run("apply with parallelism", func(t *testing.T) {
		got := buildECRebuildArgs(ecRebuildBody{
			Collection: "mybucket", DiskType: "hdd",
			MaxParallelization: 5, Apply: true,
		})
		want := []string{"-collection=mybucket", "-diskType=hdd", "-maxParallelization=5", "-apply"}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("got %v want %v", got, want)
		}
	})
}

func TestBuildECBalanceArgs(t *testing.T) {
	got := buildECBalanceArgs(ecBalanceBody{
		Collection:            "mybucket",
		DataCenter:            "dc1",
		DiskType:              "hdd",
		ShardReplicaPlacement: "001",
		MaxParallelization:    8,
		Apply:                 true,
	})
	want := []string{
		"-collection=mybucket",
		"-dataCenter=dc1",
		"-diskType=hdd",
		"-shardReplicaPlacement=001",
		"-maxParallelization=8",
		"-apply",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %v\nwant %v", got, want)
	}
}

func TestCountECBalanceMoves(t *testing.T) {
	out := `
ec.balance
would move ec shard 3 of volume 12 from 10.0.0.1 to 10.0.0.5
would move ec shard 7 of volume 14 from 10.0.0.2 to 10.0.0.6
nothing else to move
`
	if got := countECBalanceMoves(out); got != 2 {
		t.Errorf("count = %d, want 2", got)
	}
	if got := countECBalanceMoves("no moves\n"); got != 0 {
		t.Errorf("empty should be 0, got %d", got)
	}
}
