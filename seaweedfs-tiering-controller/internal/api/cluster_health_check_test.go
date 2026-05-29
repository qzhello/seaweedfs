package api

import "testing"

func TestRollupClusterStatus(t *testing.T) {
	sig := func(status string) healthSignal { return healthSignal{Key: "x", Status: status} }
	cases := []struct {
		name string
		in   []healthSignal
		want string
	}{
		{name: "all ok -> green", in: []healthSignal{sig("ok"), sig("ok")}, want: "green"},
		{name: "empty -> green", in: nil, want: "green"},
		{name: "warn -> yellow", in: []healthSignal{sig("ok"), sig("warn")}, want: "yellow"},
		{name: "unknown -> yellow", in: []healthSignal{sig("ok"), sig("unknown")}, want: "yellow"},
		{name: "down -> red", in: []healthSignal{sig("ok"), sig("down")}, want: "red"},
		{name: "down beats warn -> red", in: []healthSignal{sig("warn"), sig("down")}, want: "red"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := rollupClusterStatus(tc.in); got != tc.want {
				t.Fatalf("rollupClusterStatus(%v) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}
