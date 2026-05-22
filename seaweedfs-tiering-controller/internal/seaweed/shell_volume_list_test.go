package seaweed

import (
	"reflect"
	"testing"
)

// Regression: SeaweedFS shell emits a summary line per disk like
//   `Disk hdd {Size:... FileCount:... DeletedFileCount:... DeletedBytes:...}`
// in addition to the header line `Disk hdd(volume:.../...)`. A naive
// HasPrefix(trim, "Disk ") parser would treat the summary as a new disk
// entry and stuff the `{Size:...}` payload into DiskType. Both parsers
// must ignore the summary footer.
func TestParseVolumeList_SkipsDiskSummaryFooter(t *testing.T) {
	out := `Topology
  DataCenter dc1
    Rack rack-a
      DataNode 10.0.0.1:8080
        Disk hdd(volume:1/200 active:1 free:199 remote:0)
          volume Id:1, Size:1024, Collection:c, FileCount:1, ReadOnly:false, ModifiedAtSecond:1700000000
        Disk hdd {Size:1311586776 FileCount:16019 DeletedFileCount:0 DeletedBytes:0}
      DataNode 10.0.0.1:8080 hdd(volume:1/200) total volumes:1 active:1 free:199
`
	vols := parseVolumeListOutput(out)
	if len(vols) != 1 {
		t.Fatalf("want 1 volume, got %d: %+v", len(vols), vols)
	}
	if vols[0].DiskType != "hdd" {
		t.Errorf("DiskType polluted by summary footer: %q", vols[0].DiskType)
	}

	nodes := parseNodeDiskStats(out)
	if len(nodes) != 1 {
		t.Fatalf("want 1 node-disk entry, got %d: %+v", len(nodes), nodes)
	}
	if nodes[0].DiskType != "hdd" {
		t.Errorf("NodeDiskStats DiskType polluted by summary footer: %q", nodes[0].DiskType)
	}
}

func TestParseVolumeListEC(t *testing.T) {
	// Trimmed sample of `weed shell volume.list` output with both a normal
	// volume row and an EC volume row sharing a node + disk context.
	out := `Topology
  DataCenter dc1
    Rack rack-a
      DataNode 10.0.0.1:8080
        Disk hdd(volume:2/200 active:2 free:198 remote:0)
          volume Id:1, Size:1024, ReplicaPlacement:000, Collection:mybucket, FileCount:10, ReadOnly:false, ModifiedAtSecond:1700000000, DiskType:hdd
          ec volume id:7 collection:mybucket shards:[0 1 3] sizes:[1024 2048 4096] total:7168 disk_type:hdd
`
	vols := parseVolumeListOutput(out)
	if len(vols) != 2 {
		t.Fatalf("want 2 rows, got %d: %+v", len(vols), vols)
	}

	normal := vols[0]
	if normal.IsEC || normal.ID != 1 || normal.Size != 1024 {
		t.Errorf("normal row wrong: %+v", normal)
	}

	ec := vols[1]
	if !ec.IsEC {
		t.Errorf("EC row missing IsEC flag: %+v", ec)
	}
	if ec.ID != 7 || ec.Collection != "mybucket" {
		t.Errorf("EC row id/collection wrong: %+v", ec)
	}
	if !reflect.DeepEqual(ec.Shards, []int{0, 1, 3}) {
		t.Errorf("EC shards = %v, want [0 1 3]", ec.Shards)
	}
	if !reflect.DeepEqual(ec.ShardSizes, []uint64{1024, 2048, 4096}) {
		t.Errorf("EC sizes = %v, want [1024 2048 4096]", ec.ShardSizes)
	}
	if ec.Size != 7168 {
		t.Errorf("EC size sum = %d, want 7168", ec.Size)
	}
	if !ec.ReadOnly {
		t.Errorf("EC row should be ReadOnly=true")
	}
	if ec.Server != "10.0.0.1:8080" || ec.Rack != "rack-a" || ec.DataCenter != "dc1" {
		t.Errorf("EC row topology wrong: %+v", ec)
	}
}

func TestParseECVolumeFields_EmptySizes(t *testing.T) {
	line := "ec volume id:9 collection:mybucket shards:[] sizes:[] total:0 disk_type:ssd"
	v := parseECVolumeFields(line)
	if v.ID != 9 || v.Collection != "mybucket" || v.DiskType != "ssd" {
		t.Errorf("scalar fields wrong: %+v", v)
	}
	if len(v.Shards) != 0 || len(v.ShardSizes) != 0 || v.Size != 0 {
		t.Errorf("empty-bracket lists wrong: %+v", v)
	}
}

func TestParseECVolumeFields_IDBoundary(t *testing.T) {
	// `disk_id:5` must not satisfy the `id:` prefix.
	line := "ec volume disk_id:5 id:42 collection:c1 shards:[0] sizes:[100] total:100"
	v := parseECVolumeFields(line)
	if v.ID != 42 {
		t.Errorf("id boundary wrong: got %d, want 42", v.ID)
	}
	if v.Collection != "c1" {
		t.Errorf("collection wrong: %q", v.Collection)
	}
}

func TestDecodeEcIndexBits(t *testing.T) {
	// bits 0, 3, 13 set → shards [0 3 13]
	got := decodeEcIndexBits(1<<0 | 1<<3 | 1<<13)
	if !reflect.DeepEqual(got, []int{0, 3, 13}) {
		t.Errorf("got %v, want [0 3 13]", got)
	}
	if got := decodeEcIndexBits(0); len(got) != 0 {
		t.Errorf("zero bits should yield empty slice, got %v", got)
	}
}
