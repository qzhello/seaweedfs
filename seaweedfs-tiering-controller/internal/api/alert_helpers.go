package api

import "github.com/seaweedfs/seaweedfs-tiering-controller/internal/alerter"

// alerterEvent is a thin builder so handlers don't need to import alerter directly.
func alerterEvent(kind, source, severity, title, body string) alerter.Event {
	return alerter.Event{Kind: kind, Source: source, Severity: severity, Title: title, Body: body}
}
func boolToSeverity(b bool) string {
	if b {
		return "critical"
	}
	return "warning"
}
func boolToVerb(b bool) string {
	if b {
		return "ENGAGED"
	}
	return "RELEASED"
}
func boolToString(b bool) string {
	if b {
		return "true"
	}
	return "false"
}
