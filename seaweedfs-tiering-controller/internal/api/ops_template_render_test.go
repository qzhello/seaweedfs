package api

import "testing"

// Regression: a step referencing {{volume_id}} without a matching
// `variables` entry used to fail save validation with "placeholder
// {{volume_id}} does not resolve". autoDeclareMissingVars should
// repair the gap so the save proceeds.
func TestAutoDeclareMissingVars_AppendsBareKey(t *testing.T) {
	steps := []opsStep{{Args: "-volumeId={{volume_id}} -node={{server}}"}}
	got := autoDeclareMissingVars(nil, steps)
	if len(got) != 2 {
		t.Fatalf("want 2 auto-declared vars, got %d: %+v", len(got), got)
	}
	keys := map[string]opsTemplateVar{}
	for _, v := range got {
		keys[v.Key] = v
	}
	if _, ok := keys["volume_id"]; !ok {
		t.Errorf("missing volume_id auto-declaration: %+v", got)
	}
	if _, ok := keys["server"]; !ok {
		t.Errorf("missing server auto-declaration: %+v", got)
	}
	if keys["volume_id"].Label != "Volume id" {
		t.Errorf("humanized label wrong: %q", keys["volume_id"].Label)
	}
	if !keys["volume_id"].Required {
		t.Errorf("auto-declared var should be required by default")
	}
}

// stepN.output and stepN.capture.alias must NOT trigger a fake
// variable — they're resolved against prior steps at run time. A
// bug here would silently shadow the step output with an empty
// operator-supplied value.
func TestAutoDeclareMissingVars_SkipsStepRefs(t *testing.T) {
	steps := []opsStep{
		{Args: "-list", Capture: []opsCapture{{As: "owner", Regex: `owner="([^"]+)"`}}},
		{Args: "-name={{step1.capture.owner}} -prev={{step1.output}}"},
	}
	got := autoDeclareMissingVars(nil, steps)
	if len(got) != 0 {
		t.Errorf("step refs should not be auto-declared: %+v", got)
	}
}

// Pre-declared vars stay first; auto-declared ones append after.
func TestAutoDeclareMissingVars_PreservesExistingOrder(t *testing.T) {
	existing := []opsTemplateVar{{Key: "cluster", Label: "Cluster", Required: true}}
	steps := []opsStep{{Args: "-cluster={{cluster}} -vid={{volume_id}}"}}
	got := autoDeclareMissingVars(existing, steps)
	if len(got) != 2 || got[0].Key != "cluster" || got[1].Key != "volume_id" {
		t.Errorf("ordering wrong: %+v", got)
	}
}
