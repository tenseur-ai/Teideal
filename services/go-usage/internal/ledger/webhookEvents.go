package ledger

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"
)

type webhookEventRequest struct {
	TenantID  string `json:"tenant_id"`
	EventType string `json:"event_type"`
	DedupKey  string `json:"dedup_key"`
	Payload   any    `json:"payload"`
}

// postWebhookEvent mirrors postAlert's deliberately small, soft-failing
// outbound HTTP shape. Tenant notification must never own reconciliation.
func postWebhookEvent(ctx context.Context, tenantID, eventType, dedupKey string, payload any) error {
	baseURL := os.Getenv("TS_CONSOLE_URL")
	adminSecret := os.Getenv("ADMIN_SECRET")
	if baseURL == "" {
		return errors.New("TS_CONSOLE_URL is not configured")
	}
	if adminSecret == "" {
		return errors.New("ADMIN_SECRET is not configured")
	}
	body, err := json.Marshal(webhookEventRequest{
		TenantID: tenantID, EventType: eventType, DedupKey: dedupKey, Payload: payload,
	})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		strings.TrimRight(baseURL, "/")+"/internal/webhook-events",
		bytes.NewReader(body),
	)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Internal-Admin-Key", adminSecret)
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("webhook event endpoint returned HTTP %d", resp.StatusCode)
	}
	return nil
}
