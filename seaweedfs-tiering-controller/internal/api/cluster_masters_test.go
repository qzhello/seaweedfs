package api

import (
	"errors"
	"testing"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/seaweed"
)

func TestNormalizeMasterPeer(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{name: "http scheme", in: "http://10.0.0.2:9333/", want: "10.0.0.2:9333"},
		{name: "https scheme", in: "https://10.0.0.2:9333/status", want: "10.0.0.2:9333"},
		{name: "grpc port", in: "10.0.0.2:19333", want: "10.0.0.2:9333"},
		{name: "grpc suffix", in: "10.0.0.2:9333.19333", want: "10.0.0.2:9333"},
		{name: "high http port stays", in: "10.0.0.1:12000", want: "10.0.0.1:12000"},
		{name: "high http dual port stays", in: "10.0.0.1:12000.22000", want: "10.0.0.1:12000"},
		{name: "whitespace", in: " 10.0.0.2:9333 ", want: "10.0.0.2:9333"},
		{name: "empty", in: "", want: ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := normalizeMasterPeer(tc.in); got != tc.want {
				t.Fatalf("normalizeMasterPeer(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestBuildMasterConsistency(t *testing.T) {
	rows := []clusterMasterRow{
		{
			Address:                "10.0.0.1:9333",
			Reachable:              true,
			ReportedLeader:         "10.0.0.2:9333",
			ReportedPeers:          []string{"10.0.0.1:9333", "10.0.0.2:9333"},
			NormalizedPeers:        []string{"10.0.0.1:9333", "10.0.0.2:9333"},
			PeerDataAvailable:      true,
			normalizedPeerObserved: []string{"10.0.0.1:9333", "10.0.0.2:9333"},
		},
		{
			Address:                "10.0.0.2:9333",
			Reachable:              true,
			ReportedLeader:         "10.0.0.2.19333",
			ReportedPeers:          []string{"10.0.0.1:9333"},
			NormalizedPeers:        []string{"10.0.0.1:9333"},
			PeerDataAvailable:      true,
			normalizedPeerObserved: []string{"10.0.0.1:9333"},
		},
		{
			Address:       "10.0.0.3:9333",
			Reachable:     false,
			Error:         "dial tcp timeout",
			ReportedPeers: nil,
		},
	}

	consistency := buildMasterConsistency(rows)
	if consistency.Healthy {
		t.Fatal("expected unhealthy consistency result")
	}
	if consistency.LeaderAgreement {
		t.Fatal("expected leader disagreement")
	}
	if consistency.PeerSetAgreement {
		t.Fatal("expected peer-set disagreement")
	}
	if len(consistency.Issues) == 0 {
		t.Fatal("expected consistency issues")
	}

	hasCode := func(code string) bool {
		for _, issue := range consistency.Issues {
			if issue.Code == code {
				return true
			}
		}
		return false
	}

	if !hasCode("peer_set_disagreement") {
		t.Fatal("expected peer_set_disagreement issue")
	}
	if !hasCode("leader_disagreement") {
		t.Fatal("expected leader_disagreement issue")
	}
	if !hasCode("missing_self") {
		t.Fatal("expected missing_self issue")
	}
	if !hasCode("unreachable_master") {
		t.Fatal("expected unreachable_master issue")
	}
}

func TestBuildMasterConsistency_NoLeaderIsUnhealthy(t *testing.T) {
	rows := []clusterMasterRow{
		{
			Address:                "10.0.0.1:9333",
			Reachable:              true,
			PeerDataAvailable:      true,
			NormalizedPeers:        []string{"10.0.0.1:9333", "10.0.0.2:9333"},
			normalizedPeerObserved: []string{"10.0.0.1:9333", "10.0.0.2:9333"},
		},
		{
			Address:                "10.0.0.2:9333",
			Reachable:              true,
			PeerDataAvailable:      true,
			NormalizedPeers:        []string{"10.0.0.1:9333", "10.0.0.2:9333"},
			normalizedPeerObserved: []string{"10.0.0.1:9333", "10.0.0.2:9333"},
		},
	}

	consistency := buildMasterConsistency(rows)
	if consistency.Healthy {
		t.Fatal("expected no-leader state to be unhealthy")
	}
	if consistency.LeaderAgreement {
		t.Fatal("expected leader agreement to be false without a derived leader")
	}

	hasCode := func(code string) bool {
		for _, issue := range consistency.Issues {
			if issue.Code == code {
				return true
			}
		}
		return false
	}
	if !hasCode("no_leader") {
		t.Fatal("expected no_leader issue")
	}
}

func TestMapLockProbeResult(t *testing.T) {
	t.Run("acquired => free", func(t *testing.T) {
		got := mapLockProbeResult("10.0.0.1:9333", "shell",
			seaweed.LockProbeOutcome{Acquired: true, LockTsNs: 42}, nil)
		if got.Status != "free" || got.Holder != "" {
			t.Fatalf("unexpected: %#v", got)
		}
	})
	t.Run("held => held with holder", func(t *testing.T) {
		got := mapLockProbeResult("10.0.0.1:9333", "shell",
			seaweed.LockProbeOutcome{Held: true, Holder: "controller@host-a", RawError: "already locked by controller@host-a: lease"},
			errors.New("already locked by controller@host-a: lease"))
		if got.Status != "held" || got.Holder != "controller@host-a" {
			t.Fatalf("unexpected: %#v", got)
		}
	})
	t.Run("not leader => quorum_unhealthy", func(t *testing.T) {
		got := mapLockProbeResult("10.0.0.1:9333", "shell",
			seaweed.LockProbeOutcome{NotLeader: true, RawError: "NotLeader"},
			errors.New("NotLeader"))
		if got.Status != "quorum_unhealthy" {
			t.Fatalf("unexpected: %#v", got)
		}
	})
	t.Run("dial failure => quorum_unhealthy", func(t *testing.T) {
		got := mapLockProbeResult("10.0.0.1:9333", "shell",
			seaweed.LockProbeOutcome{RawError: "dial tcp: i/o timeout"},
			errors.New("dial tcp: i/o timeout"))
		if got.Status != "quorum_unhealthy" || got.Message == "" {
			t.Fatalf("unexpected: %#v", got)
		}
	})
}

func TestBuildMasterConsistency_DetectsDuplicatePeersAfterDedupe(t *testing.T) {
	rows := []clusterMasterRow{
		{
			Address:                "10.0.0.1:9333",
			Reachable:              true,
			IsLeader:               true,
			PeerDataAvailable:      true,
			ReportedLeader:         "10.0.0.1:9333",
			ReportedPeers:          []string{"10.0.0.1:9333", "10.0.0.1:19333"},
			NormalizedPeers:        []string{"10.0.0.1:9333"},
			normalizedPeerObserved: []string{"10.0.0.1:9333", "10.0.0.1:9333"},
		},
	}

	consistency := buildMasterConsistency(rows)
	hasCode := func(code string) bool {
		for _, issue := range consistency.Issues {
			if issue.Code == code {
				return true
			}
		}
		return false
	}
	if !hasCode("duplicate_peer_entries") {
		t.Fatal("expected duplicate_peer_entries issue")
	}
}
