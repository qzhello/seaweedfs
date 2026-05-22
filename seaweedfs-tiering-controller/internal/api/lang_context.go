package api

import (
	"context"
	"strings"

	"github.com/gin-gonic/gin"
)

// langMiddleware copies the X-Tier-Lang request header onto the gin
// request's context.Context so downstream handlers can call
// LangFromCtx(c.Request.Context()) without re-reading the header.
// Missing/empty header defaults to "en" inside WithLang.
func langMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		lang := c.GetHeader("X-Tier-Lang")
		c.Request = c.Request.WithContext(WithLang(c.Request.Context(), lang))
		c.Next()
	}
}

// langCtxKey is the unexported context key for the operator's UI locale.
// We pull this from the X-Tier-Lang request header (set by the web
// frontend) so AI prompt builders can localize the model's reply to
// match what the operator sees in the browser.
type langCtxKey struct{}

// WithLang returns ctx tagged with the given locale. Empty input
// degrades to "en" so callers don't have to special-case "no locale" —
// English is a safe default for the LLM.
func WithLang(ctx context.Context, lang string) context.Context {
	lang = strings.TrimSpace(strings.ToLower(lang))
	if lang == "" {
		lang = "en"
	}
	return context.WithValue(ctx, langCtxKey{}, lang)
}

// LangFromCtx returns the locale stored on ctx, or "en" when none was
// attached.
func LangFromCtx(ctx context.Context) string {
	if v, ok := ctx.Value(langCtxKey{}).(string); ok && v != "" {
		return v
	}
	return "en"
}

// IsZh reports whether the ctx-bound locale is Chinese. Centralized so
// prompt builders don't sprinkle string comparisons.
func IsZh(ctx context.Context) bool {
	return strings.HasPrefix(LangFromCtx(ctx), "zh")
}
