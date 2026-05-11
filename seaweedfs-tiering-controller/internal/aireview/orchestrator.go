// Package aireview orchestrates the multi-round AI safety review that runs
// before a tiering task is allowed to execute.
//
// Three rounds, each prompted with a slightly different lens:
//
//	1. initial_scan   — quick yes/no: does this action make sense at all?
//	2. deep_analysis  — given cohort + cyclical pattern context, what are the
//	                    real tradeoffs?
//	3. devils_advocate — adversarial: list every reason this should NOT run.
//
// The orchestrator aggregates the three round verdicts into one final
// verdict using a simple voting + confidence rule. The aggregate is what the
// scheduler / approval flow gates on.
package aireview

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"go.uber.org/zap"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/ai"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

// Verdict mirrors the persisted enum.
type Verdict string

const (
	VerdictProceed    Verdict = "proceed"
	VerdictAbort      Verdict = "abort"
	VerdictNeedsHuman Verdict = "needs_human"
)

// Inputs is everything the prompts need. The orchestrator does not look up
// data from the database directly — callers pre-populate this so prompts stay
// reproducible across re-runs.
type Inputs struct {
	TaskID         uuid.UUID
	VolumeID       uint32
	Collection     string
	Action         string
	Score          float64
	Features       map[string]float64
	Explanation    string
	BusinessDomain string
	CohortContext  string // e.g. "domain=hotel n=42 mean_z=0.0 stddev=1.2"
	PatternContext string // e.g. "cycle=daily acf24=0.71"
	Risk           string // optional risk hint from skill registry
	Lang           string // "zh" or "en" — controls reasoning/note language. Empty == en.
}

// langDirective appends a sentence telling the LLM which natural language to
// use in free-text fields. The JSON schema itself stays English so parsing
// behavior doesn't change.
func langDirective(lang string) string {
	switch strings.ToLower(strings.TrimSpace(lang)) {
	case "zh", "zh-cn", "zh_cn", "chinese":
		return "\nIMPORTANT: Write the `reasoning` and every factor `note` in 简体中文. Keys and verdict values stay English."
	default:
		return ""
	}
}

// Service is the entry point for callers (scheduler, manual /tasks/:id/review).
type Service struct {
	pg          *store.PG
	resolver    *ai.Resolver
	defaultProv ai.Provider // metric-instrumented default provider
	log         *zap.Logger
}

func NewService(pg *store.PG, resolver *ai.Resolver, defaultProv ai.Provider, log *zap.Logger) *Service {
	return &Service{pg: pg, resolver: resolver, defaultProv: defaultProv, log: log}
}

// Run executes all three rounds, persisting after each. Returns the aggregate
// verdict + the review ID so the caller can link to it.
func (s *Service) Run(ctx context.Context, in Inputs) (uuid.UUID, Verdict, error) {
	if in.Lang == "" && s.pg != nil {
		if cfg, err := s.pg.GetConfig(ctx, "aireview.lang"); err == nil && cfg != nil {
			var v string
			if json.Unmarshal(cfg.Value, &v) == nil {
				in.Lang = v
			}
		}
	}
	provider, providerID, providerName, err := s.pickProvider(ctx)
	if err != nil {
		return uuid.Nil, VerdictNeedsHuman, fmt.Errorf("pick provider: %w", err)
	}
	reviewID, err := s.pg.CreateAIReview(ctx, in.TaskID, providerID, providerName)
	if err != nil {
		return uuid.Nil, VerdictNeedsHuman, err
	}

	rounds := []roundSpec{
		{number: 1, kind: "initial_scan", prompt: promptInitialScan},
		{number: 2, kind: "deep_analysis", prompt: promptDeepAnalysis},
		{number: 3, kind: "devils_advocate", prompt: promptDevilsAdvocate},
	}

	var verdicts []Verdict
	var confidences []float64
	for _, spec := range rounds {
		round, err := s.runRound(ctx, provider, reviewID, spec, in)
		if err != nil {
			s.log.Warn("ai review round failed",
				zap.String("kind", spec.kind), zap.Error(err))
			// Persist the round error and abort the review — don't gamble
			// with partial signal.
			_ = s.pg.UpsertAIReviewRound(ctx, store.AIReviewRound{
				ReviewID: reviewID, RoundNumber: spec.number, RoundKind: spec.kind,
				Error: err.Error(), StartedAt: time.Now(),
			})
			_ = s.pg.FinishAIReview(ctx, reviewID, string(VerdictNeedsHuman), 0, err.Error())
			return reviewID, VerdictNeedsHuman, err
		}
		if round.Verdict != nil {
			verdicts = append(verdicts, Verdict(*round.Verdict))
		}
		if round.Confidence != nil {
			confidences = append(confidences, *round.Confidence)
		}
	}

	verdict, conf := aggregate(verdicts, confidences)
	if err := s.pg.FinishAIReview(ctx, reviewID, string(verdict), conf, ""); err != nil {
		return reviewID, verdict, err
	}
	return reviewID, verdict, nil
}

// pickProvider tries the persisted default provider first, falling back to
// the in-memory default (compiled from config.AI). Returns nil id if the
// fallback is used so the review row records the name only.
func (s *Service) pickProvider(ctx context.Context) (ai.Provider, *uuid.UUID, string, error) {
	if s.resolver != nil && s.pg != nil {
		row, err := s.pg.GetDefaultAIProvider(ctx)
		if err == nil && row != nil {
			p, err := s.resolver.Build(row)
			if err == nil {
				return p, &row.ID, row.Name, nil
			}
			s.log.Warn("default provider build failed; falling back",
				zap.String("name", row.Name), zap.Error(err))
		}
	}
	if s.defaultProv == nil {
		return nil, nil, "", fmt.Errorf("no AI provider available")
	}
	return s.defaultProv, nil, s.defaultProv.Name(), nil
}

type roundSpec struct {
	number int
	kind   string
	prompt func(in Inputs) string
}

// runRound issues the prompt, parses the JSON response, and persists the
// round. Returns the parsed round so the orchestrator can aggregate.
func (s *Service) runRound(ctx context.Context, provider ai.Provider, reviewID uuid.UUID, spec roundSpec, in Inputs) (store.AIReviewRound, error) {
	prompt := spec.prompt(in)
	start := time.Now()

	jr, ok := provider.(jsonChatter)
	var (
		resp string
		err  error
	)
	if ok {
		resp, err = jr.JSONChat(ctx, prompt)
	} else {
		// Rule provider or any non-LLM Provider: fall back to Explain. The
		// rule provider returns a fixed string and the parser will fail —
		// but that's logged as a parse error and the aggregator can still
		// reach a verdict from the other rounds. For LLMs we always have
		// JSONChat, so this path is exercised only by Rule.
		resp, err = provider.Explain(ctx, ai.ExplainInput{
			VolumeID: in.VolumeID, Collection: in.Collection,
			Action: in.Action, Score: in.Score, Features: in.Features,
		})
	}
	dur := int(time.Since(start) / time.Millisecond)

	round := store.AIReviewRound{
		ReviewID:    reviewID,
		RoundNumber: spec.number,
		RoundKind:   spec.kind,
		Prompt:      truncate(prompt, 4000),
		RawResponse: truncate(resp, 4000),
		DurationMs:  &dur,
		StartedAt:   time.Now(),
	}
	if err != nil {
		round.Error = err.Error()
		return round, s.pg.UpsertAIReviewRound(ctx, round)
	}

	parsed, perr := parseRoundResponse(resp)
	if perr != nil {
		// Don't fail the whole review — record the parse error and let the
		// aggregator decide.  A run with one unparseable round still has 2/3
		// votes.
		round.Error = "parse: " + perr.Error()
		return round, s.pg.UpsertAIReviewRound(ctx, round)
	}
	round.Verdict = ptrString(string(parsed.Verdict))
	round.Confidence = ptrFloat(parsed.Confidence)
	round.Reasoning = parsed.Reasoning
	if b, err := json.Marshal(parsed.Factors); err == nil {
		round.Factors = b
	}
	return round, s.pg.UpsertAIReviewRound(ctx, round)
}

// jsonChatter is implemented by providers that can accept a raw prompt and
// return raw text. internal/ai.OpenAICompat satisfies this via a thin shim.
// Anthropic also satisfies it.  Rule provider does not (it fails fast in
// runRound, which the aggregator handles).
type jsonChatter interface {
	JSONChat(ctx context.Context, prompt string) (string, error)
}

// ----------------------- prompts -------------------------------------------

const promptHeader = `You are part of a multi-round safety review for a SeaweedFS volume tiering controller.
You MUST reply with strict JSON only — no prose around it. Schema:
{"verdict":"proceed|abort|needs_human","confidence":0..1,"reasoning":"<=200 chars","factors":[{"name":"<short>","weight":0..1,"note":"<=80 chars"}]}`

func headerFor(lang string) string { return promptHeader + langDirective(lang) }

func promptInitialScan(in Inputs) string {
	return fmt.Sprintf(`%s

Round 1 — Initial scan.
Goal: a fast yes/no on whether this action is reasonable at first glance.

Volume: %d collection=%q action=%s score=%.3f
Features: %s
Risk hint: %s

Reply only with the JSON object.`,
		headerFor(in.Lang), in.VolumeID, in.Collection, in.Action, in.Score,
		formatFeatures(in.Features), in.Risk)
}

func promptDeepAnalysis(in Inputs) string {
	return fmt.Sprintf(`%s

Round 2 — Deep analysis.
Consider cohort context and cyclical patterns. Identify the SINGLE biggest tradeoff.

Volume: %d collection=%q action=%s score=%.3f
Business domain: %s
Cohort context: %s
Pattern context: %s
Rule explanation: %s

Reply only with the JSON object.`,
		headerFor(in.Lang), in.VolumeID, in.Collection, in.Action, in.Score,
		in.BusinessDomain, in.CohortContext, in.PatternContext, in.Explanation)
}

func promptDevilsAdvocate(in Inputs) string {
	return fmt.Sprintf(`%s

Round 3 — Devil's advocate.
Argue AGAINST executing this action. List concrete reasons it could go wrong
(re-warming, peak hours, cohort outlier, replication risk, …).
If you find any deal-breaker, set verdict=abort. If concerns are real but
manageable, set verdict=needs_human.

Volume: %d action=%s score=%.3f
Business domain: %s
Cohort context: %s
Pattern context: %s

Reply only with the JSON object.`,
		headerFor(in.Lang), in.VolumeID, in.Action, in.Score,
		in.BusinessDomain, in.CohortContext, in.PatternContext)
}

// ----------------------- response parsing ----------------------------------

type parsedRound struct {
	Verdict    Verdict
	Confidence float64
	Reasoning  string
	Factors    []factor
}

type factor struct {
	Name   string  `json:"name"`
	Weight float64 `json:"weight"`
	Note   string  `json:"note,omitempty"`
}

func parseRoundResponse(s string) (*parsedRound, error) {
	// Strip code fences if the model wrapped JSON in ```json … ```
	s = strings.TrimSpace(s)
	if strings.HasPrefix(s, "```") {
		s = strings.TrimPrefix(s, "```json")
		s = strings.TrimPrefix(s, "```")
		s = strings.TrimSuffix(s, "```")
		s = strings.TrimSpace(s)
	}
	// Extract first balanced JSON object.
	start := strings.Index(s, "{")
	end := strings.LastIndex(s, "}")
	if start < 0 || end <= start {
		return nil, fmt.Errorf("no JSON object found")
	}
	s = s[start : end+1]

	var raw struct {
		Verdict    string   `json:"verdict"`
		Confidence float64  `json:"confidence"`
		Reasoning  string   `json:"reasoning"`
		Factors    []factor `json:"factors"`
	}
	if err := json.Unmarshal([]byte(s), &raw); err != nil {
		return nil, err
	}
	v := Verdict(strings.ToLower(strings.TrimSpace(raw.Verdict)))
	switch v {
	case VerdictProceed, VerdictAbort, VerdictNeedsHuman:
	default:
		return nil, fmt.Errorf("unknown verdict %q", raw.Verdict)
	}
	if raw.Confidence < 0 {
		raw.Confidence = 0
	} else if raw.Confidence > 1 {
		raw.Confidence = 1
	}
	if len(raw.Reasoning) > 500 {
		raw.Reasoning = raw.Reasoning[:500]
	}
	return &parsedRound{
		Verdict: v, Confidence: raw.Confidence,
		Reasoning: raw.Reasoning, Factors: raw.Factors,
	}, nil
}

// aggregate is a deliberately conservative voting rule: any abort wins,
// then any needs_human wins, otherwise proceed. Confidence is the mean of
// participating rounds.
func aggregate(verdicts []Verdict, confidences []float64) (Verdict, float64) {
	if len(verdicts) == 0 {
		return VerdictNeedsHuman, 0
	}
	var sum float64
	for _, c := range confidences {
		sum += c
	}
	conf := 0.0
	if len(confidences) > 0 {
		conf = sum / float64(len(confidences))
	}
	for _, v := range verdicts {
		if v == VerdictAbort {
			return VerdictAbort, conf
		}
	}
	for _, v := range verdicts {
		if v == VerdictNeedsHuman {
			return VerdictNeedsHuman, conf
		}
	}
	return VerdictProceed, conf
}

// ---------- helpers ---------------------------------------------------------

func formatFeatures(f map[string]float64) string {
	if len(f) == 0 {
		return "(none)"
	}
	parts := make([]string, 0, len(f))
	for k, v := range f {
		parts = append(parts, fmt.Sprintf("%s=%.2f", k, v))
	}
	return strings.Join(parts, " ")
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

func ptrString(s string) *string  { return &s }
func ptrFloat(f float64) *float64 { return &f }
