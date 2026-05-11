package aireview

import (
	"strings"
	"testing"
)

func TestParseRoundResponse_Plain(t *testing.T) {
	in := `{"verdict":"proceed","confidence":0.92,"reasoning":"clearly cold","factors":[{"name":"acf24","weight":0.8,"note":"flat"}]}`
	got, err := parseRoundResponse(in)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if got.Verdict != VerdictProceed {
		t.Fatalf("verdict=%s", got.Verdict)
	}
	if got.Confidence != 0.92 {
		t.Fatalf("conf=%v", got.Confidence)
	}
	if len(got.Factors) != 1 || got.Factors[0].Name != "acf24" {
		t.Fatalf("factors=%+v", got.Factors)
	}
}

func TestParseRoundResponse_FencedAndPadded(t *testing.T) {
	// LLMs love wrapping in ```json … ``` and adding stray prose.
	in := "Sure, here is the JSON:\n```json\n" +
		`{"verdict":"abort","confidence":0.7,"reasoning":"will re-warm","factors":[]}` +
		"\n```\nlet me know if you need more."
	got, err := parseRoundResponse(in)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if got.Verdict != VerdictAbort {
		t.Fatalf("verdict=%s", got.Verdict)
	}
}

func TestParseRoundResponse_BadVerdict(t *testing.T) {
	_, err := parseRoundResponse(`{"verdict":"maybe","confidence":0.5}`)
	if err == nil || !strings.Contains(err.Error(), "unknown verdict") {
		t.Fatalf("expected unknown-verdict error, got %v", err)
	}
}

func TestParseRoundResponse_NoJSON(t *testing.T) {
	_, err := parseRoundResponse("the model said no")
	if err == nil {
		t.Fatal("expected error on no-JSON input")
	}
}

func TestParseRoundResponse_ConfidenceClamped(t *testing.T) {
	got, err := parseRoundResponse(`{"verdict":"proceed","confidence":1.5}`)
	if err != nil {
		t.Fatal(err)
	}
	if got.Confidence != 1 {
		t.Fatalf("expected clamp to 1, got %v", got.Confidence)
	}
	got, err = parseRoundResponse(`{"verdict":"proceed","confidence":-0.2}`)
	if err != nil {
		t.Fatal(err)
	}
	if got.Confidence != 0 {
		t.Fatalf("expected clamp to 0, got %v", got.Confidence)
	}
}

func TestAggregate_AbortBeatsProceed(t *testing.T) {
	v, _ := aggregate(
		[]Verdict{VerdictProceed, VerdictAbort, VerdictProceed},
		[]float64{0.9, 0.6, 0.95},
	)
	if v != VerdictAbort {
		t.Fatalf("expected abort to win, got %s", v)
	}
}

func TestAggregate_NeedsHumanBeatsProceed(t *testing.T) {
	v, conf := aggregate(
		[]Verdict{VerdictProceed, VerdictNeedsHuman, VerdictProceed},
		[]float64{1, 0.5, 1},
	)
	if v != VerdictNeedsHuman {
		t.Fatalf("expected needs_human, got %s", v)
	}
	// Confidence is mean of participating rounds — sanity check.
	if conf < 0.83 || conf > 0.84 {
		t.Fatalf("conf=%v expected ~0.833", conf)
	}
}

func TestAggregate_AllProceed(t *testing.T) {
	v, _ := aggregate(
		[]Verdict{VerdictProceed, VerdictProceed, VerdictProceed},
		[]float64{0.9, 0.85, 0.92},
	)
	if v != VerdictProceed {
		t.Fatalf("expected proceed, got %s", v)
	}
}

func TestAggregate_Empty(t *testing.T) {
	v, conf := aggregate(nil, nil)
	if v != VerdictNeedsHuman {
		t.Fatalf("empty input must default to needs_human, got %s", v)
	}
	if conf != 0 {
		t.Fatalf("conf=%v expected 0", conf)
	}
}
