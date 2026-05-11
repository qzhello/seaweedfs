package api

import (
	"fmt"
	"regexp"
	"strings"
)

// opsTemplateVar declares a single operator-provided input. Values are
// collected by the run dialog before the first step fires, and then
// substituted into every step's args wherever `{{name}}` appears.
type opsTemplateVar struct {
	Key      string `json:"key"`                // identifier used in {{...}} refs
	Label    string `json:"label,omitempty"`    // human label for the run form
	Required bool   `json:"required,omitempty"` // UI marks with asterisk
	Default  string `json:"default,omitempty"`  // pre-filled value
	Help     string `json:"help,omitempty"`     // helper text under the input
}

// opsCapture extracts data from a step's stdout into a named slot so
// later steps can reference it via `{{stepN.capture.alias}}`. The
// regex is run against the full stdout; the first capture group (or
// the whole match if no group is present) becomes the value.
type opsCapture struct {
	As    string `json:"as"`    // alias used in placeholders
	Regex string `json:"regex"` // Go regexp; first () group wins
}

// placeholderRE matches `{{ word.dot.word }}` with optional whitespace.
// Keys allow letters/digits/underscore/dot. We deliberately reject `$`
// and other shell metacharacters so a renamed variable can't accidentally
// expand into a flag boundary.
var placeholderRE = regexp.MustCompile(`{{\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*}}`)

// extractPlaceholders returns every `{{key}}` referenced in `s`.
func extractPlaceholders(s string) []string {
	if !strings.Contains(s, "{{") {
		return nil
	}
	matches := placeholderRE.FindAllStringSubmatch(s, -1)
	out := make([]string, 0, len(matches))
	seen := map[string]bool{}
	for _, m := range matches {
		if !seen[m[1]] {
			seen[m[1]] = true
			out = append(out, m[1])
		}
	}
	return out
}

// validateTemplatePlaceholders walks each step and ensures every
// `{{...}}` reference resolves to either a declared variable or a
// prior step's `output` / `capture.<alias>`. Returns an error the
// save handler can surface to the operator before they hit Run and
// see a runtime failure.
func validateTemplatePlaceholders(vars []opsTemplateVar, steps []opsStep) error {
	declared := map[string]bool{}
	for _, v := range vars {
		if v.Key == "" {
			return fmt.Errorf("variable: empty key")
		}
		declared[v.Key] = true
	}
	for i, s := range steps {
		// Each step also exposes a stable identifier for downstream refs.
		stepKey := fmt.Sprintf("step%d", i+1)
		// Validate regex compiles up front so the operator sees the
		// problem at save time, not at run time.
		for _, cap := range s.Capture {
			if cap.As == "" {
				return fmt.Errorf("step %d: capture missing alias", i+1)
			}
			if _, err := regexp.Compile(cap.Regex); err != nil {
				return fmt.Errorf("step %d capture %q: invalid regex: %w", i+1, cap.As, err)
			}
		}
		for _, ref := range extractPlaceholders(s.Args) {
			if declared[ref] {
				continue
			}
			// stepN.output / stepN.capture.alias — verify N < current,
			// and the capture alias was declared on that step.
			parts := strings.Split(ref, ".")
			if len(parts) >= 2 && strings.HasPrefix(parts[0], "step") {
				var refIdx int
				if _, err := fmt.Sscanf(parts[0], "step%d", &refIdx); err == nil && refIdx >= 1 && refIdx <= i {
					prior := steps[refIdx-1]
					switch parts[1] {
					case "output":
						if len(parts) == 2 {
							continue
						}
					case "capture":
						if len(parts) == 3 {
							for _, cap := range prior.Capture {
								if cap.As == parts[2] {
									goto ok
								}
							}
						}
					}
				}
			}
			return fmt.Errorf("step %d: placeholder {{%s}} does not resolve to a declared variable or prior step output", i+1, ref)
		ok:
		}
		_ = stepKey
	}
	return nil
}

// substituteArgs returns `args` with every `{{...}}` replaced from the
// scope. Unknown refs become the empty string (validation should have
// caught them at save time, but the runner is defensive). Captures are
// looked up under `step<i>.capture.<alias>`.
func substituteArgs(args string, scope map[string]string) string {
	if !strings.Contains(args, "{{") {
		return args
	}
	return placeholderRE.ReplaceAllStringFunc(args, func(m string) string {
		sub := placeholderRE.FindStringSubmatch(m)
		if len(sub) < 2 {
			return m
		}
		if v, ok := scope[sub[1]]; ok {
			return v
		}
		return ""
	})
}

// applyCaptures runs each capture regex against `stdout` and stores
// the result in `scope` under `stepN.capture.<alias>`. The first
// regex group is preferred; if the pattern has no group, the whole
// match is used. A miss leaves the slot empty so substituteArgs can
// distinguish "no match" from "match empty string".
func applyCaptures(stepIndex int, stdout string, captures []opsCapture, scope map[string]string) {
	for _, cap := range captures {
		re, err := regexp.Compile(cap.Regex)
		if err != nil {
			continue
		}
		m := re.FindStringSubmatch(stdout)
		var v string
		if m != nil {
			if len(m) >= 2 {
				v = m[1]
			} else {
				v = m[0]
			}
		}
		scope[fmt.Sprintf("step%d.capture.%s", stepIndex, cap.As)] = v
	}
}
