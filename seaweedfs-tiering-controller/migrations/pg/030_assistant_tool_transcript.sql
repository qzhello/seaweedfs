-- ============================================================
-- 030: assistant_messages.tool_transcript — persist what the LLM
-- did (which tools it called, with what args, what came back) so
-- the floating assistant can replay the same play-by-play when an
-- operator re-opens an old chat.
-- ============================================================
--
-- Without this column the live SSE stream is the only source of
-- truth for tool interactions: reload the page and you'd see just
-- the final text answer, with no clue which tools were involved.
-- That makes audits / postmortems much harder.
--
-- Schema: an array of objects, one per executed tool call in the
-- order the model issued them:
--   [
--     {"call_id":"...", "name":"list_volumes",
--      "arguments":"{...}", "content":"{...}", "is_error":false},
--     ...
--   ]
-- NULL or [] means "no tools used" (legacy chats or pure-text turns).

ALTER TABLE assistant_messages
    ADD COLUMN IF NOT EXISTS tool_transcript JSONB;
