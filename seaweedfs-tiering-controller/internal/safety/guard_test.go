package safety

import "testing"

func TestEmergencyStopVerdict(t *testing.T) {
	tests := []struct {
		name     string
		stopped  bool
		wantOK   bool
		wantCode string
	}{
		{name: "not stopped allows", stopped: false, wantOK: true, wantCode: ""},
		{name: "stopped blocks", stopped: true, wantOK: false, wantCode: "emergency_stop"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			v := emergencyStopVerdict(tc.stopped)
			if v.Allowed != tc.wantOK {
				t.Fatalf("Allowed = %v, want %v", v.Allowed, tc.wantOK)
			}
			if v.Code != tc.wantCode {
				t.Fatalf("Code = %q, want %q", v.Code, tc.wantCode)
			}
			if tc.wantOK {
				if v.Code != "" || v.Reason != "" {
					t.Fatalf("allowed verdict should have empty Code/Reason, got %+v", v)
				}
			} else if v.Reason == "" {
				t.Fatal("blocked verdict must have a non-empty reason")
			}
		})
	}
}
