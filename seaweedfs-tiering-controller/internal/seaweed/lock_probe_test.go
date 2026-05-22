package seaweed

import "testing"

func TestParseAlreadyLockedHolder(t *testing.T) {
	tests := []struct {
		name      string
		in        string
		wantOK    bool
		wantValue string
	}{
		{
			name:      "canonical master error",
			in:        "already locked by controller@host-a: tiering-controller lock probe",
			wantOK:    true,
			wantValue: "controller@host-a",
		},
		{
			name:      "wrapped by grpc",
			in:        "rpc error: code = Unknown desc = already locked by shell@10.0.0.5: lease",
			wantOK:    true,
			wantValue: "shell@10.0.0.5",
		},
		{name: "unrelated error", in: "dial tcp: i/o timeout", wantOK: false},
		{name: "marker without value", in: "already locked by : msg", wantOK: false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := parseAlreadyLockedHolder(tc.in)
			if ok != tc.wantOK || got != tc.wantValue {
				t.Fatalf("parseAlreadyLockedHolder(%q) = (%q, %v), want (%q, %v)", tc.in, got, ok, tc.wantValue, tc.wantOK)
			}
		})
	}
}
