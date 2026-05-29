package api

import (
	"reflect"
	"testing"
)

func TestValidateTransferTarget(t *testing.T) {
	cases := []struct {
		name    string
		id      string
		addr    string
		wantErr bool
	}{
		{name: "both empty (auto)", id: "", addr: "", wantErr: false},
		{name: "both set", id: "m2", addr: "10.0.0.2:19333", wantErr: false},
		{name: "id only", id: "m2", addr: "", wantErr: true},
		{name: "addr only", id: "", addr: "10.0.0.2:19333", wantErr: true},
		{name: "id with space", id: "m 2", addr: "10.0.0.2:19333", wantErr: true},
		{name: "address with space", id: "m2", addr: "10.0.0.2:19333 -force", wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := validateTransferTarget(tc.id, tc.addr)
			if (err != nil) != tc.wantErr {
				t.Fatalf("validateTransferTarget(%q,%q) err=%v, wantErr=%v", tc.id, tc.addr, err, tc.wantErr)
			}
		})
	}
}

func TestBuildTransferArgs(t *testing.T) {
	if got := buildTransferArgs("", ""); len(got) != 0 {
		t.Fatalf("auto mode should yield no args, got %v", got)
	}
	got := buildTransferArgs("m2", "10.0.0.2:19333")
	want := []string{"-id=m2", "-address=10.0.0.2:19333"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("buildTransferArgs = %v, want %v", got, want)
	}
}
