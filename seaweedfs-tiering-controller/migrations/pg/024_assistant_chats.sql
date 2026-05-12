-- ============================================================
-- Migration 024 — AI floating-assistant chat threads
--
-- Per-user chat threads with assistant messages, auto-trimmed
-- to the most recent 50 entries per chat by the application
-- layer (TrimAssistantHistory). The capability `ai.assistant`
-- gates access from the API surface.
-- ============================================================

CREATE TABLE IF NOT EXISTS assistant_chats (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title      TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_assistant_chats_user
    ON assistant_chats(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS assistant_messages (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_id    UUID NOT NULL REFERENCES assistant_chats(id) ON DELETE CASCADE,
    role       TEXT NOT NULL CHECK (role IN ('user','assistant')),
    content    TEXT NOT NULL,
    cluster_id UUID,
    page_path  TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_assistant_messages_chat
    ON assistant_messages(chat_id, created_at);

-- ---------- Capability seed (matches 022 schema) ----------
INSERT INTO capabilities (name, category, label, description) VALUES
  ('ai.assistant', 'ai', 'AI assistant chat',
   'Use the floating AI assistant to ask SOP-grounded operator questions.')
ON CONFLICT (name) DO UPDATE
  SET category    = EXCLUDED.category,
      label       = EXCLUDED.label,
      description = EXCLUDED.description;

INSERT INTO role_capabilities (role, capability) VALUES
  ('admin',    'ai.assistant'),
  ('operator', 'ai.assistant')
ON CONFLICT (role, capability) DO NOTHING;
