package api

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

// inferenceResult is what the LLM returns: the operator-confirmable
// values plus a markdown narrative explaining how each one was
// derived. The narrative is the difference between "trust me" and
// "here's the evidence" — operators get to read the AI's reasoning
// before approving a mutation.
type inferenceResult struct {
	Values   map[string]string `json:"values"`
	Analysis string            `json:"analysis"`
}

// inferVarValues asks the configured AI provider to derive operator-
// confirmable values for the given InferVars based on prior step
// outputs in `scope`. Returns both the values and a markdown
// rationale. Errors degrade gracefully — the caller still pauses
// for operator input, it just won't have a pre-fill suggestion.
//
// Prompt design:
//   - We pin the model to JSON-only output for parseability.
//   - The output shape is { "values": {...}, "analysis": "..." }.
//     `analysis` is markdown the operator reads to audit the choice
//     — e.g. "I scanned step 1 stdout. Server A had 47 volumes
//     (highest), Server B had 12 (lowest)." Without this the
//     proposal looked magical.
//   - Each inference target carries the operator's plain-English
//     hint verbatim so operators can audit the question being asked.
func inferVarValues(
	ctx context.Context, d Deps,
	infers []opsVarInference, scope map[string]string, currentStepIdx int,
) (*inferenceResult, error) {
	if len(infers) == 0 {
		return nil, nil
	}
	provider, err := resolveAssistantProvider(ctx, d)
	if err != nil {
		return nil, fmt.Errorf("no AI provider available for inference: %w", err)
	}
	chatter, ok := provider.(jsonChatter)
	if !ok {
		return nil, fmt.Errorf("configured AI provider can't do freeform inference")
	}
	prompt, haveOutputs := buildInferencePrompt(ctx, infers, scope, currentStepIdx)
	if !haveOutputs {
		// No prior step output to ground inference. Asking the model
		// anyway just invites hallucination — it'll cheerfully invent
		// addresses like 192.168.1.10. Better to fail loud so the
		// operator hand-fills values from real context.
		//
		// Diagnostic: list which referenced steps are empty so the
		// operator can fix the template (e.g. wrong step number, or
		// step 1 is a command that writes to stderr / produces no
		// stdout like s3.bucket.create).
		missing := emptyReferencedSteps(infers, scope, currentStepIdx)
		return nil, fmt.Errorf(
			"AI cannot infer values: no prior step output to read. "+
				"Empty stdout from %s. Common causes: (1) the referenced step "+
				"writes to stderr instead of stdout, (2) wrong from_step number "+
				"in the template, (3) the command was confirmed but produced no "+
				"output. Fill the variables manually below, or fix the template's "+
				"infer_vars to point at a step that prints to stdout.",
			missing)
	}
	raw, err := chatter.JSONChat(ctx, prompt)
	if err != nil {
		return nil, fmt.Errorf("AI inference call: %w", err)
	}
	cleaned := extractJSONObject(raw)
	// Tolerant envelope: models often emit numeric volume_ids, bools,
	// etc. for what we render as flag values, so accept `any` and
	// coerce to string ourselves.
	var envelope struct {
		Values   map[string]any `json:"values"`
		Analysis string         `json:"analysis"`
	}
	if jerr := json.Unmarshal([]byte(cleaned), &envelope); jerr != nil || envelope.Values == nil {
		// Older / less obedient models sometimes still emit a flat
		// var→value object. Accept that as legacy fallback and
		// surface a stub analysis so the UI doesn't show empty.
		var flat map[string]any
		if jerr2 := json.Unmarshal([]byte(cleaned), &flat); jerr2 != nil {
			return nil, fmt.Errorf("AI returned invalid JSON: %w (raw: %s)", jerr, truncate(cleaned, 200))
		}
		envelope.Values = flat
		envelope.Analysis = "(no rationale supplied by the model — flat values returned)"
	}
	// Trim each value and drop empties — empty strings would render
	// as literal "" in the next step's args, which is rarely useful.
	clean := map[string]string{}
	for _, inf := range infers {
		if raw, ok := envelope.Values[inf.Var]; ok {
			v := strings.TrimSpace(coerceScalarToString(raw))
			if v != "" {
				clean[inf.Var] = v
			}
		}
	}
	return &inferenceResult{
		Values:   clean,
		Analysis: strings.TrimSpace(envelope.Analysis),
	}, nil
}

// buildInferencePrompt assembles the JSON-only instruction sent to
// the LLM. We deliberately list the OUTPUTS of named prior steps
// rather than the entire scope so the model isn't tempted to invent
// values for unrelated variables.
func buildInferencePrompt(ctx context.Context, infers []opsVarInference, scope map[string]string, currentStepIdx int) (string, bool) {
	var sb strings.Builder
	sb.WriteString("You are reading the stdout of one or more SeaweedFS shell commands.\n")
	sb.WriteString("Your job is to extract specific values an operator will use in the NEXT step,\n")
	sb.WriteString("AND to write a short markdown rationale so the operator can audit how you picked each value.\n")
	sb.WriteString("Do not wrap the JSON in markdown fences. Output ONE JSON object — no prose before or after.\n\n")
	sb.WriteString("CRITICAL grounding rules — read before you answer:\n")
	sb.WriteString("1. Every value you put in `values` MUST appear VERBATIM somewhere in the `## Step outputs` section below. Copy strings character-for-character — do not paraphrase, do not reformat, do not invent.\n")
	sb.WriteString("2. NEVER invent server addresses, IPs, hostnames, volume IDs, collection names, or any identifier. If you can't find one in the step output, OMIT that variable from `values` entirely. The operator will hand-fill it.\n")
	sb.WriteString("3. Do NOT use placeholder/example values like `192.168.1.x`, `server-A`, `example.com`, `<value>`. These are forbidden.\n")
	sb.WriteString("4. In `analysis`, quote the exact line from step output that supports each picked value, so the operator can grep for it.\n\n")
	// Tell the model which language to write the human-readable
	// `analysis` field in. The `values` are flag values consumed by
	// weed shell so they stay verbatim (server names, volume ids).
	if IsZh(ctx) {
		sb.WriteString("用简体中文撰写 `analysis` 字段(Markdown 格式)。`values` 里的内容必须保持原样(服务器地址、卷 ID 等),不要翻译。\n\n")
	} else {
		sb.WriteString("Write the `analysis` field in English. Keep `values` verbatim from the source output (server addresses, volume IDs).\n\n")
	}

	sb.WriteString("## Requested values\n")
	for _, inf := range infers {
		from := "(any prior step)"
		if inf.FromStep > 0 {
			from = fmt.Sprintf("step %d", inf.FromStep)
		}
		sb.WriteString(fmt.Sprintf("- %q (from %s): %s\n", inf.Var, from, inf.Hint))
	}
	sb.WriteString("\n## Step outputs\n")

	// Emit outputs for the steps each inference cares about. If
	// FromStep is 0 ("any prior"), include every prior step's
	// output. We truncate per-step to keep prompt size bounded.
	included := map[int]bool{}
	for _, inf := range infers {
		if inf.FromStep > 0 {
			included[inf.FromStep] = true
			continue
		}
		// "any prior" → include every step before the current one.
		for i := 1; i <= currentStepIdx; i++ {
			included[i] = true
		}
	}
	emitted := 0
	for i := 1; i <= currentStepIdx; i++ {
		if !included[i] {
			continue
		}
		out := scope[fmt.Sprintf("step%d.output", i)]
		if strings.TrimSpace(out) == "" {
			continue
		}
		sb.WriteString(fmt.Sprintf("### step %d output\n```\n%s\n```\n\n",
			i, truncate(out, 8000)))
		emitted++
	}

	sb.WriteString("## Response format\n")
	sb.WriteString("Output ONLY this JSON envelope:\n")
	sb.WriteString("```\n")
	exValues := map[string]string{}
	for _, inf := range infers {
		exValues[inf.Var] = "<value>"
	}
	example := map[string]any{
		"values": exValues,
		"analysis": "## What I observed\n" +
			"- (Quote the actual line from the step output here, e.g. `Volume server <host>:<port> has N volumes` — use the real strings you see above, NOT placeholders.)\n\n" +
			"## Why I picked these values\n" +
			"- `<var_name>` ← <verbatim value from step output> (one-line reason grounded in the quote above)\n",
	}
	b, _ := json.MarshalIndent(example, "", "  ")
	sb.WriteString(string(b))
	sb.WriteString("\n```\n")
	sb.WriteString("\nWrite the `analysis` field as concise markdown. Quote the EXACT lines from the step output that justify each picked value. Keep it under ~150 words.\n")
	sb.WriteString("\nFinal reminder: if a requested value is not literally present in the step output above, OMIT it from `values` — leave it for the operator to fill manually rather than guessing.\n")
	return sb.String(), emitted > 0
}

// emptyReferencedSteps returns a human-readable list of step numbers
// whose stdout the inference needed but couldn't find. Used purely to
// build a diagnostic error message so the operator knows which step in
// their template is the dead end.
//
// Three distinct failure shapes get distinguished here so the error
// message tells the operator exactly what to fix in the template:
//   1. infer_vars sit on the first step — there's no prior step at all.
//   2. infer_vars reference a step > currentStep (forward reference).
//   3. The referenced prior step exists but printed no stdout.
func emptyReferencedSteps(infers []opsVarInference, scope map[string]string, currentStepIdx int) string {
	// currentStepIdx is the 0-based index of the step ABOUT TO RUN.
	// If it's 0, we're on step 1 — no priors exist by definition.
	if currentStepIdx == 0 {
		return "step 1 (this is the first step — there are no prior steps to read output from; move infer_vars to a later step, or remove them)"
	}
	want := map[int]bool{}
	var forward []int
	for _, inf := range infers {
		if inf.FromStep > 0 {
			if inf.FromStep > currentStepIdx {
				// Forward reference — the step it's pointing at
				// hasn't run yet (or doesn't exist at all).
				forward = append(forward, inf.FromStep)
				continue
			}
			want[inf.FromStep] = true
			continue
		}
		for i := 1; i <= currentStepIdx; i++ {
			want[i] = true
		}
	}
	if len(forward) > 0 {
		labels := make([]string, 0, len(forward))
		for _, n := range forward {
			labels = append(labels, fmt.Sprintf("step %d", n))
		}
		return fmt.Sprintf("forward reference to %s (current step is %d — infer_vars.from_step must point at a step that has already run)",
			strings.Join(labels, ", "), currentStepIdx+1)
	}
	var empty []string
	for i := 1; i <= currentStepIdx; i++ {
		if !want[i] {
			continue
		}
		if strings.TrimSpace(scope[fmt.Sprintf("step%d.output", i)]) == "" {
			empty = append(empty, fmt.Sprintf("step %d", i))
		}
	}
	if len(empty) == 0 {
		// Shouldn't normally happen — buildInferencePrompt only sets
		// haveOutputs=false when at least one referenced step was
		// empty. Keep a safe fallback.
		return "(no referenced step produced stdout)"
	}
	return strings.Join(empty, ", ")
}

// coerceScalarToString renders the JSON scalars an LLM might emit
// (string, number, bool) into the flag-value form weed shell expects.
// Numbers use %v so 23 stays "23" not "23.000000"; arrays/objects fall
// back to JSON encoding so the operator at least sees something
// reviewable instead of "<nil>".
func coerceScalarToString(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case float64:
		// json.Unmarshal into any always gives float64 for numbers.
		// Render ints without trailing ".0".
		if x == float64(int64(x)) {
			return fmt.Sprintf("%d", int64(x))
		}
		return fmt.Sprintf("%v", x)
	case bool:
		if x {
			return "true"
		}
		return "false"
	default:
		b, err := json.Marshal(x)
		if err != nil {
			return fmt.Sprintf("%v", x)
		}
		return string(b)
	}
}

// truncate caps s to at most n chars, appending an ellipsis when
// trimmed. Bytes-based to keep the prompt accountable; the model
// doesn't care about utf-8 grapheme boundaries here.
func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "\n…(truncated)"
}
