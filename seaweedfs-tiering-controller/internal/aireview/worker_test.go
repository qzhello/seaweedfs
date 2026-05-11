package aireview

import "testing"

func TestRiskAllowed(t *testing.T) {
	tests := []struct {
		level, cap string
		want       bool
	}{
		{"low", "low", true},
		{"low", "medium", true},
		{"medium", "medium", true},
		{"medium", "low", false},  // medium > low cap
		{"high", "medium", false}, // high always rejected
		{"high", "high", false},   // even with high cap, high is hard-coded out
		{"critical", "high", false},
		{"critical", "critical", false},
		{"low", "", false},     // empty cap rejects
		{"", "low", false},     // empty level rejects
	}
	for _, tc := range tests {
		got := riskAllowed(tc.level, tc.cap)
		if got != tc.want {
			t.Errorf("riskAllowed(%q,%q)=%v want %v", tc.level, tc.cap, got, tc.want)
		}
	}
}

func TestActionToSkillKey(t *testing.T) {
	cases := map[string]string{
		"tier_upload":     "volume.tier_upload",
		"ec_encode":       "volume.ec_encode",
		"shrink":          "volume.shrink",
		"collection_move": "collection.move",
		"failover_check":  "cluster.failover_check",
		"unknown_action":  "",
	}
	for in, want := range cases {
		if got := actionToSkillKey(in); got != want {
			t.Errorf("actionToSkillKey(%q)=%q want %q", in, got, want)
		}
	}
}
