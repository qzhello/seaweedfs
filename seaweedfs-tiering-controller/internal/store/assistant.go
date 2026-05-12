package store

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// AssistantChat is one floating-assistant conversation thread owned by a user.
type AssistantChat struct {
	ID        uuid.UUID `json:"id"`
	UserID    uuid.UUID `json:"user_id"`
	Title     string    `json:"title"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// AssistantMessage is a single user-or-assistant turn within a chat.
type AssistantMessage struct {
	ID        uuid.UUID  `json:"id"`
	ChatID    uuid.UUID  `json:"chat_id"`
	Role      string     `json:"role"`
	Content   string     `json:"content"`
	ClusterID *uuid.UUID `json:"cluster_id,omitempty"`
	PagePath  string     `json:"page_path,omitempty"`
	CreatedAt time.Time  `json:"created_at"`
}

// ListAssistantChats returns the user's chats, most-recently-updated first.
func (p *PG) ListAssistantChats(ctx context.Context, userID uuid.UUID) ([]AssistantChat, error) {
	rows, err := p.Pool.Query(ctx, `
		SELECT id, user_id, title, created_at, updated_at
		FROM assistant_chats
		WHERE user_id=$1
		ORDER BY updated_at DESC`, userID)
	if err != nil {
		return nil, fmt.Errorf("list assistant chats: %w", err)
	}
	defer rows.Close()
	out := []AssistantChat{}
	for rows.Next() {
		var c AssistantChat
		if err := rows.Scan(&c.ID, &c.UserID, &c.Title, &c.CreatedAt, &c.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan assistant chat: %w", err)
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// CreateAssistantChat inserts a fresh chat row. The title may be empty;
// callers typically backfill it from the first user message.
func (p *PG) CreateAssistantChat(ctx context.Context, userID uuid.UUID, title string) (AssistantChat, error) {
	var c AssistantChat
	row := p.Pool.QueryRow(ctx, `
		INSERT INTO assistant_chats (user_id, title)
		VALUES ($1, $2)
		RETURNING id, user_id, title, created_at, updated_at`, userID, title)
	if err := row.Scan(&c.ID, &c.UserID, &c.Title, &c.CreatedAt, &c.UpdatedAt); err != nil {
		return AssistantChat{}, fmt.Errorf("create assistant chat: %w", err)
	}
	return c, nil
}

// DeleteAssistantChat removes a chat (and cascades messages) iff the user owns it.
func (p *PG) DeleteAssistantChat(ctx context.Context, userID, chatID uuid.UUID) error {
	tag, err := p.Pool.Exec(ctx, `
		DELETE FROM assistant_chats WHERE id=$1 AND user_id=$2`, chatID, userID)
	if err != nil {
		return fmt.Errorf("delete assistant chat: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("delete assistant chat: not found or not owned")
	}
	return nil
}

// RenameAssistantChat updates the title iff the user owns the chat.
func (p *PG) RenameAssistantChat(ctx context.Context, userID, chatID uuid.UUID, title string) error {
	tag, err := p.Pool.Exec(ctx, `
		UPDATE assistant_chats SET title=$1, updated_at=now()
		WHERE id=$2 AND user_id=$3`, title, chatID, userID)
	if err != nil {
		return fmt.Errorf("rename assistant chat: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("rename assistant chat: not found or not owned")
	}
	return nil
}

// ListAssistantMessages returns messages in chronological order (oldest first).
// `limit` defaults to 50 if <= 0; we still load oldest-first within the slice
// so callers can pass them straight to a chat-completion API.
func (p *PG) ListAssistantMessages(ctx context.Context, chatID uuid.UUID, limit int) ([]AssistantMessage, error) {
	if limit <= 0 {
		limit = 50
	}
	rows, err := p.Pool.Query(ctx, `
		SELECT id, chat_id, role, content, cluster_id, COALESCE(page_path,''), created_at
		FROM (
			SELECT id, chat_id, role, content, cluster_id, page_path, created_at
			FROM assistant_messages
			WHERE chat_id=$1
			ORDER BY created_at DESC
			LIMIT $2
		) s
		ORDER BY created_at ASC`, chatID, limit)
	if err != nil {
		return nil, fmt.Errorf("list assistant messages: %w", err)
	}
	defer rows.Close()
	out := []AssistantMessage{}
	for rows.Next() {
		var m AssistantMessage
		if err := rows.Scan(&m.ID, &m.ChatID, &m.Role, &m.Content, &m.ClusterID, &m.PagePath, &m.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan assistant message: %w", err)
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// AppendAssistantMessage inserts a new turn for the chat. Callers are
// responsible for ordering (user before assistant) and for calling
// TrimAssistantHistory afterward.
func (p *PG) AppendAssistantMessage(ctx context.Context, chatID uuid.UUID, role, content string, clusterID *uuid.UUID, pagePath string) (AssistantMessage, error) {
	var m AssistantMessage
	row := p.Pool.QueryRow(ctx, `
		INSERT INTO assistant_messages (chat_id, role, content, cluster_id, page_path)
		VALUES ($1, $2, $3, $4, NULLIF($5,''))
		RETURNING id, chat_id, role, content, cluster_id, COALESCE(page_path,''), created_at`,
		chatID, role, content, clusterID, pagePath)
	if err := row.Scan(&m.ID, &m.ChatID, &m.Role, &m.Content, &m.ClusterID, &m.PagePath, &m.CreatedAt); err != nil {
		return AssistantMessage{}, fmt.Errorf("append assistant message: %w", err)
	}
	return m, nil
}

// TrimAssistantHistory keeps only the most recent `keep` rows for a chat and
// bumps the chat's updated_at. Caller picks `keep` (we use 50 by default).
func (p *PG) TrimAssistantHistory(ctx context.Context, chatID uuid.UUID, keep int) error {
	if keep <= 0 {
		keep = 50
	}
	tx, err := p.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("trim begin: %w", err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `
		DELETE FROM assistant_messages
		WHERE chat_id=$1
		  AND id NOT IN (
		    SELECT id FROM assistant_messages
		    WHERE chat_id=$1
		    ORDER BY created_at DESC
		    LIMIT $2
		  )`, chatID, keep); err != nil {
		return fmt.Errorf("trim assistant history: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE assistant_chats SET updated_at=now() WHERE id=$1`, chatID); err != nil {
		return fmt.Errorf("trim touch chat: %w", err)
	}
	return tx.Commit(ctx)
}

// TouchAssistantChat bumps updated_at without touching messages.
func (p *PG) TouchAssistantChat(ctx context.Context, chatID uuid.UUID) error {
	_, err := p.Pool.Exec(ctx, `
		UPDATE assistant_chats SET updated_at=now() WHERE id=$1`, chatID)
	if err != nil {
		return fmt.Errorf("touch assistant chat: %w", err)
	}
	return nil
}

// GetAssistantChat fetches a single chat iff owned by the user.
func (p *PG) GetAssistantChat(ctx context.Context, userID, chatID uuid.UUID) (*AssistantChat, error) {
	row := p.Pool.QueryRow(ctx, `
		SELECT id, user_id, title, created_at, updated_at
		FROM assistant_chats
		WHERE id=$1 AND user_id=$2`, chatID, userID)
	var c AssistantChat
	if err := row.Scan(&c.ID, &c.UserID, &c.Title, &c.CreatedAt, &c.UpdatedAt); err != nil {
		return nil, fmt.Errorf("get assistant chat: %w", err)
	}
	return &c, nil
}
