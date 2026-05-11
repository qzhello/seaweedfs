// Package storage handles connection tests against S3-compatible backends.
// We don't pull the AWS SDK; an AWS SigV4-signed HEAD request is enough to
// validate (endpoint reachable, credentials valid, bucket exists, region OK).
// This keeps the binary small and the dependency surface explicit.
package storage

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

const emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" // sha256("")

// Test performs a HEAD bucket request and returns nil on 2xx/3xx, error otherwise.
// The plaintext secret is passed in by the caller (already decrypted).
func Test(ctx context.Context, b store.Backend, secret string) error {
	if b.Endpoint == "" {
		return fmt.Errorf("endpoint required")
	}
	if b.Bucket == "" {
		return fmt.Errorf("bucket required")
	}
	region := b.Region
	if region == "" {
		region = "us-east-1"
	}

	endpoint := b.Endpoint
	if !strings.HasPrefix(endpoint, "http://") && !strings.HasPrefix(endpoint, "https://") {
		endpoint = "https://" + endpoint
	}
	u, err := url.Parse(endpoint)
	if err != nil {
		return fmt.Errorf("parse endpoint: %w", err)
	}
	if b.ForcePathStyle || b.Kind == "minio" {
		u.Path = "/" + b.Bucket
	} else {
		u.Host = b.Bucket + "." + u.Host
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodHead, u.String(), nil)
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	signSigV4(req, b.AccessKeyID, secret, region, "s3", time.Now().UTC(), emptyHash)

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("connect: %w", err)
	}
	_ = resp.Body.Close()
	switch {
	case resp.StatusCode >= 200 && resp.StatusCode < 400:
		return nil
	case resp.StatusCode == 403:
		return fmt.Errorf("forbidden — credentials reject by backend (status 403)")
	case resp.StatusCode == 404:
		return fmt.Errorf("bucket not found (status 404)")
	default:
		return fmt.Errorf("unexpected status %d", resp.StatusCode)
	}
}

// ---------------- AWS SigV4 (minimal) ----------------
// We only need HEAD with empty body, single region, single service. This
// implementation supports that and nothing more.

func signSigV4(req *http.Request, ak, sk, region, service string, now time.Time, payloadHash string) {
	amzDate := now.Format("20060102T150405Z")
	dateStamp := now.Format("20060102")
	req.Header.Set("X-Amz-Date", amzDate)
	req.Header.Set("X-Amz-Content-Sha256", payloadHash)
	req.Header.Set("Host", req.URL.Host)

	canonicalURI := req.URL.EscapedPath()
	if canonicalURI == "" {
		canonicalURI = "/"
	}
	canonicalQuery := canonicalQueryString(req.URL.Query())
	canonicalHeaders, signedHeaders := buildCanonicalHeaders(req.Header)

	canonicalRequest := strings.Join([]string{
		req.Method, canonicalURI, canonicalQuery,
		canonicalHeaders, signedHeaders, payloadHash,
	}, "\n")

	credScope := fmt.Sprintf("%s/%s/%s/aws4_request", dateStamp, region, service)
	stringToSign := strings.Join([]string{
		"AWS4-HMAC-SHA256", amzDate, credScope, sha256Hex([]byte(canonicalRequest)),
	}, "\n")

	kDate := hmacSHA256([]byte("AWS4"+sk), []byte(dateStamp))
	kRegion := hmacSHA256(kDate, []byte(region))
	kService := hmacSHA256(kRegion, []byte(service))
	kSigning := hmacSHA256(kService, []byte("aws4_request"))
	signature := hex.EncodeToString(hmacSHA256(kSigning, []byte(stringToSign)))

	req.Header.Set("Authorization", fmt.Sprintf(
		"AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s",
		ak, credScope, signedHeaders, signature))
}

func canonicalQueryString(values url.Values) string {
	if len(values) == 0 {
		return ""
	}
	keys := make([]string, 0, len(values))
	for k := range values {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var buf bytes.Buffer
	for i, k := range keys {
		if i > 0 {
			buf.WriteByte('&')
		}
		buf.WriteString(url.QueryEscape(k))
		buf.WriteByte('=')
		buf.WriteString(url.QueryEscape(values.Get(k)))
	}
	return buf.String()
}

func buildCanonicalHeaders(h http.Header) (string, string) {
	keys := make([]string, 0, len(h))
	for k := range h {
		k = strings.ToLower(k)
		if k == "host" || k == "x-amz-date" || k == "x-amz-content-sha256" {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	var buf bytes.Buffer
	for _, k := range keys {
		buf.WriteString(k)
		buf.WriteByte(':')
		buf.WriteString(strings.TrimSpace(h.Get(k)))
		buf.WriteByte('\n')
	}
	return buf.String(), strings.Join(keys, ";")
}

func hmacSHA256(key, data []byte) []byte {
	m := hmac.New(sha256.New, key)
	m.Write(data)
	return m.Sum(nil)
}

func sha256Hex(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}
