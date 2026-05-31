package api

import (
	"reflect"
	"testing"
)

func TestValidateScrubMode(t *testing.T) {
	cases := []struct {
		in      string
		want    string
		wantErr bool
	}{
		{in: "", want: "local"},
		{in: "local", want: "local"},
		{in: "INDEX", want: "index"},
		{in: "Full", want: "full"},
		{in: "deep", wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.in, func(t *testing.T) {
			got, err := validateScrubMode(tc.in)
			if (err != nil) != tc.wantErr {
				t.Fatalf("validateScrubMode(%q) err=%v wantErr=%v", tc.in, err, tc.wantErr)
			}
			if !tc.wantErr && got != tc.want {
				t.Fatalf("validateScrubMode(%q)=%q want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestParseECScrubOutput(t *testing.T) {
	t.Run("no failures", func(t *testing.T) {
		out := "using LOCAL mode\nScrubbing 10.0.0.1:8080 (1/2)...\nScrubbing 10.0.0.2:8080 (2/2)...\nScrubbed 1234 EC files and 7 volumes on 2 nodes\n"
		got := parseECScrubOutput(out)
		if got.BrokenVolumes != 0 || got.BrokenShards != 0 {
			t.Fatalf("expected zero broken, got %+v", got)
		}
		if len(got.AffectedVolumes) != 0 || len(got.AffectedShards) != 0 {
			t.Fatalf("expected empty lists, got %+v", got)
		}
	})

	t.Run("with failures", func(t *testing.T) {
		out := "Scrubbed 10 EC files and 3 volumes on 2 nodes\n" +
			"\nGot scrub failures on 2 EC volumes and 3 EC shards :(\n" +
			"Affected volumes: 10.0.0.1:8080:7, 10.0.0.2:8080:9\n" +
			"Affected shards:  10.0.0.1:8080:7:3, 10.0.0.1:8080:7:5, 10.0.0.2:8080:9:1\n" +
			"Details:\n\t[10.0.0.1:8080] crc mismatch shard 3\n"
		got := parseECScrubOutput(out)
		if got.BrokenVolumes != 2 || got.BrokenShards != 3 {
			t.Fatalf("counts = %d/%d, want 2/3", got.BrokenVolumes, got.BrokenShards)
		}
		wantVols := []string{"10.0.0.1:8080:7", "10.0.0.2:8080:9"}
		if !reflect.DeepEqual(got.AffectedVolumes, wantVols) {
			t.Fatalf("affected volumes = %v, want %v", got.AffectedVolumes, wantVols)
		}
		wantShards := []string{"10.0.0.1:8080:7:3", "10.0.0.1:8080:7:5", "10.0.0.2:8080:9:1"}
		if !reflect.DeepEqual(got.AffectedShards, wantShards) {
			t.Fatalf("affected shards = %v, want %v", got.AffectedShards, wantShards)
		}
	})

	t.Run("empty", func(t *testing.T) {
		got := parseECScrubOutput("")
		if got.BrokenVolumes != 0 || len(got.AffectedShards) != 0 {
			t.Fatalf("expected zero/empty for empty input, got %+v", got)
		}
		// Slices must be non-nil (they serialize to JSON [] not null).
		if got.AffectedVolumes == nil || got.AffectedShards == nil {
			t.Fatalf("affected lists must be non-nil, got %+v", got)
		}
	})

	t.Run("broken volumes but no broken shards", func(t *testing.T) {
		// ec.scrub omits the "Affected shards:" line when there are none.
		out := "\nGot scrub failures on 1 EC volumes and 0 EC shards :(\n" +
			"Affected volumes: 10.0.0.1:8080:7\n"
		got := parseECScrubOutput(out)
		if got.BrokenVolumes != 1 || got.BrokenShards != 0 {
			t.Fatalf("counts = %d/%d, want 1/0", got.BrokenVolumes, got.BrokenShards)
		}
		if got.AffectedShards == nil {
			t.Fatal("AffectedShards must be non-nil even when absent")
		}
		if len(got.AffectedShards) != 0 {
			t.Fatalf("expected empty AffectedShards, got %v", got.AffectedShards)
		}
	})
}
