package api

import (
	"testing"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/seaweed"
)

func TestBuildCollectionDetail(t *testing.T) {
	vols := []seaweed.VolumeInfo{
		{ID: 1, Collection: "photos", Size: 100, FileCount: 10, Server: "vs1", ReplicaPlace: 10},
		{ID: 1, Collection: "photos", Size: 100, FileCount: 10, Server: "vs2", ReplicaPlace: 10},
		{ID: 2, Collection: "photos", Size: 200, FileCount: 20, Server: "vs1", IsEC: true, Shards: []int{0, 1, 2}},
		{ID: 3, Collection: "logs", Size: 999, Server: "vs1"}, // different collection — ignored
	}
	got := buildCollectionDetail("photos", vols)
	if got.VolumeCount != 2 {
		t.Fatalf("VolumeCount = %d, want 2", got.VolumeCount)
	}
	if got.ReplicaRowCount != 3 {
		t.Fatalf("ReplicaRowCount = %d, want 3", got.ReplicaRowCount)
	}
	if got.TotalSize != 400 {
		t.Fatalf("TotalSize = %d, want 400", got.TotalSize)
	}
	if got.FileCount != 40 {
		t.Fatalf("FileCount = %d, want 40", got.FileCount)
	}
	if got.ECVolumeCount != 1 {
		t.Fatalf("ECVolumeCount = %d, want 1", got.ECVolumeCount)
	}
	if got.ReplicationDistribution["010"] != 2 {
		t.Fatalf("expected 2 replicas at placement 010, got %v", got.ReplicationDistribution)
	}
	if got.ReplicationDistribution["ec"] != 1 {
		t.Fatalf("expected 1 ec row, got %v", got.ReplicationDistribution)
	}
	if got.ServerDistribution["vs1"] != 2 || got.ServerDistribution["vs2"] != 1 {
		t.Fatalf("unexpected server distribution: %v", got.ServerDistribution)
	}
}

func TestBuildCollectionDetail_DefaultCollection(t *testing.T) {
	vols := []seaweed.VolumeInfo{
		{ID: 1, Collection: "", Size: 50, Server: "vs1"},
		{ID: 2, Collection: "named", Size: 1000, Server: "vs1"},
	}
	got := buildCollectionDetail("", vols)
	if got.VolumeCount != 1 || got.TotalSize != 50 {
		t.Fatalf("unexpected default-collection detail: %#v", got)
	}
}

func TestBuildVolumeServerDetail(t *testing.T) {
	vols := []seaweed.VolumeInfo{
		{ID: 1, Server: "10.0.0.1:8080", Size: 100, Collection: "photos", DataCenter: "dc1", Rack: "r1"},
		{ID: 2, Server: "10.0.0.1:8080", Size: 50, Collection: "logs", ReadOnly: true},
		{ID: 3, Server: "10.0.0.2:8080", Size: 999}, // different server — ignored
		{ID: 4, Server: "10.0.0.1:8080", Size: 30, IsEC: true, Shards: []int{0, 1}},
	}
	nodes := []seaweed.NodeDiskStats{
		{Server: "10.0.0.1:8080", DiskType: "hdd", VolumeCount: 2, MaxVolumeCount: 100, FreeVolumeCount: 98, UsedBytes: 150, DataCenter: "dc1", Rack: "r1"},
		{Server: "10.0.0.1:8080", DiskType: "ssd", VolumeCount: 1, MaxVolumeCount: 50, FreeVolumeCount: 49, UsedBytes: 30},
		{Server: "10.0.0.2:8080", DiskType: "hdd"}, // ignored
	}
	got := buildVolumeServerDetail("10.0.0.1:8080", vols, nodes)
	if got.VolumeCount != 3 {
		t.Fatalf("VolumeCount = %d, want 3", got.VolumeCount)
	}
	if got.UsedBytes != 180 {
		t.Fatalf("UsedBytes = %d, want 180", got.UsedBytes)
	}
	if got.ECShardCount != 2 {
		t.Fatalf("ECShardCount = %d, want 2", got.ECShardCount)
	}
	if got.ReadOnlyCount != 1 {
		t.Fatalf("ReadOnlyCount = %d, want 1", got.ReadOnlyCount)
	}
	if got.MaxVolumes != 150 || got.FreeVolumes != 147 {
		t.Fatalf("disk totals wrong: max=%d free=%d", got.MaxVolumes, got.FreeVolumes)
	}
	if len(got.Disks) != 2 {
		t.Fatalf("expected 2 disks, got %d", len(got.Disks))
	}
	if got.DataCenter != "dc1" || got.Rack != "r1" {
		t.Fatalf("placement not picked up: dc=%q rack=%q", got.DataCenter, got.Rack)
	}
}

func TestBuildVolumeDetail_Replicated(t *testing.T) {
	vols := []seaweed.VolumeInfo{
		{ID: 7, Collection: "photos", Server: "vs1", Size: 100, FileCount: 10, ReplicaPlace: 10},
		{ID: 7, Collection: "photos", Server: "vs2", Size: 100, FileCount: 10, ReplicaPlace: 10},
		{ID: 8, Collection: "logs", Server: "vs1", Size: 999}, // unrelated — ignored
	}
	got, ok := buildVolumeDetail(7, vols)
	if !ok {
		t.Fatal("expected volume 7 to be found")
	}
	if got.ReplicaCount != 2 || got.TotalSize != 200 || got.Placement != "010" {
		t.Fatalf("unexpected: %#v", got)
	}
	if got.IsEC {
		t.Fatal("expected non-EC volume")
	}
	if len(got.ECShardsPresent) != 0 || len(got.ECShardsMissing) != 0 {
		t.Fatalf("non-EC should not report shards: %#v", got)
	}
}

func TestBuildVolumeDetail_EC(t *testing.T) {
	vols := []seaweed.VolumeInfo{
		{ID: 42, Collection: "cold", Server: "vs1", IsEC: true, Shards: []int{0, 1, 2}, ShardSizes: []uint64{10, 20, 30}, Size: 60},
		{ID: 42, Collection: "cold", Server: "vs2", IsEC: true, Shards: []int{3, 4, 5, 6, 7}, Size: 50},
		{ID: 42, Collection: "cold", Server: "vs3", IsEC: true, Shards: []int{8, 9}, Size: 20},
	}
	got, ok := buildVolumeDetail(42, vols)
	if !ok {
		t.Fatal("expected volume 42 to be found")
	}
	if !got.IsEC || got.ReplicaCount != 3 {
		t.Fatalf("unexpected: %#v", got)
	}
	if got.ECShardCount != 10 {
		t.Fatalf("ECShardCount = %d, want 10", got.ECShardCount)
	}
	if len(got.ECShardsMissing) != 4 {
		t.Fatalf("expected 4 missing (10..13), got %v", got.ECShardsMissing)
	}
	for i, want := range []int{10, 11, 12, 13} {
		if got.ECShardsMissing[i] != want {
			t.Fatalf("missing[%d] = %d, want %d", i, got.ECShardsMissing[i], want)
		}
	}
}

func TestBuildVolumeDetail_NotFound(t *testing.T) {
	if _, ok := buildVolumeDetail(999, []seaweed.VolumeInfo{{ID: 1}}); ok {
		t.Fatal("expected not found for unknown vid")
	}
}

func TestBuildECShards_HealthyVsMissing(t *testing.T) {
	full := make([]int, 14)
	for i := range full {
		full[i] = i
	}
	vols := []seaweed.VolumeInfo{
		{ID: 1, Collection: "cold", Server: "vs1", IsEC: true, Shards: full},
		// volume 2 has shards 0..9 only — 4 missing.
		{ID: 2, Collection: "cold", Server: "vs1", IsEC: true, Shards: []int{0, 1, 2, 3, 4}},
		{ID: 2, Collection: "cold", Server: "vs2", IsEC: true, Shards: []int{5, 6, 7, 8, 9}},
		{ID: 99, Server: "vs1"}, // non-EC — ignored
	}
	got := buildECShards(vols)
	if got.TotalShards != 14 {
		t.Fatalf("TotalShards = %d", got.TotalShards)
	}
	if len(got.Volumes) != 2 {
		t.Fatalf("expected 2 EC volumes, got %d", len(got.Volumes))
	}
	// Unhealthy first.
	if got.Volumes[0].ID != 2 || got.Volumes[0].Healthy {
		t.Fatalf("expected vol 2 (unhealthy) first, got %#v", got.Volumes[0])
	}
	if got.Volumes[0].ShardsMissing != 4 {
		t.Fatalf("vol 2 should be missing 4, got %d", got.Volumes[0].ShardsMissing)
	}
	if !got.Volumes[1].Healthy || got.Volumes[1].ShardsMissing != 0 {
		t.Fatalf("vol 1 should be healthy, got %#v", got.Volumes[1])
	}
}

func TestFormatReplicaPlacement(t *testing.T) {
	tests := []struct {
		code uint32
		ec   bool
		want string
	}{
		{0, false, "000"},
		{10, false, "010"},
		{100, false, "100"},
		{111, false, "111"},
		{0, true, "ec"},
	}
	for _, tc := range tests {
		if got := formatReplicaPlacement(tc.code, tc.ec); got != tc.want {
			t.Fatalf("formatReplicaPlacement(0x%x,%v) = %q, want %q", tc.code, tc.ec, got, tc.want)
		}
	}
}
