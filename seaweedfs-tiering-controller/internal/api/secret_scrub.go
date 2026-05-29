package api

// Secret scrubbing for the generic shell exec path. Commands like
// s3.accesskey.create / s3.accesskey.rotate / s3.iam.export print plaintext
// secret keys to stdout, and operators can pass -secret_key=... in args.
// Without scrubbing, those secrets leak into HTTP responses, SSE streams,
// and the audit log. Dedicated handlers (e.g. s3UpsertIdentity) already
// omit credentials; this gives the generic path the same protection.

import (
	"regexp"
	"strings"
)

const secretRedacted = "***REDACTED***"

// secretLineRe matches a "secret key" / "secret_key" / "secretKey" /
// "secret:" label followed by its value (after : or =), optionally quoted.
// The value is replaced with a redaction marker while keeping the label.
var secretLineRe = regexp.MustCompile(`(?i)(secret[ _]?key\s*[:=]\s*|secretkey\s*[:=]\s*|secret\s*[:=]\s*)("?)[^\s"]+("?)`)

// secretArgRe matches a CLI flag carrying a secret value, e.g.
// -secret_key=xxx, -secretKey=xxx, --secret=xxx (case-insensitive).
var secretArgRe = regexp.MustCompile(`(?i)^(-{1,2}secret[a-z_]*=).+$`)

// scrubSecretText redacts secret-bearing substrings from shell stdout so
// access keys created/rotated/exported via the generic shell don't leak.
func scrubSecretText(s string) string {
	if s == "" {
		return s
	}
	return secretLineRe.ReplaceAllString(s, `${1}${2}`+secretRedacted+`${3}`)
}

// scrubSecretArgs returns a copy of args with any secret-bearing flag value
// redacted, for safe audit logging and response echoing.
func scrubSecretArgs(args []string) []string {
	if len(args) == 0 {
		return args
	}
	out := make([]string, len(args))
	for i, a := range args {
		if loc := secretArgRe.FindStringIndex(a); loc != nil {
			if eq := strings.IndexByte(a, '='); eq >= 0 {
				out[i] = a[:eq+1] + secretRedacted
				continue
			}
		}
		out[i] = a
	}
	return out
}
