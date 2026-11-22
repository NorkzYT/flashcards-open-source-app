-- Schemas touched/read explicitly: ai, security, pg_catalog.
-- Fences the standalone claim and its recovery on the exact current dispatch lease (0255), and carries a
-- standalone person's own provider key to the lease holder as short-lived ciphertext (below). Callers assert
-- the lease inside the transaction that claims or interrupts the run, before they lock the run row, so the order is
-- always dispatch row -> run row -> session row. The recovery sweep skips locked rows, so it can neither
-- requeue nor re-lease a dispatch while a holder is claiming or interrupting under it.
CREATE FUNCTION ai.assert_chat_run_dispatch_lease(
  p_run_id UUID, p_session_id UUID, p_user_id TEXT, p_workspace_id UUID,
  p_lease_token UUID, p_lease_owner TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  held ai.chat_run_dispatches%ROWTYPE;
BEGIN
  IF p_run_id IS NULL OR p_session_id IS NULL OR p_user_id IS NULL OR p_workspace_id IS NULL
    OR p_lease_token IS NULL OR p_lease_owner IS NULL
  THEN
    RAISE EXCEPTION 'every dispatch lease fence field is required' USING ERRCODE = '22023';
  END IF;

  SELECT dispatches.* INTO held
  FROM ai.chat_run_dispatches AS dispatches
  WHERE dispatches.run_id = p_run_id
  FOR UPDATE;

  -- clock_timestamp: a holder that waited on the lock (or on earlier work in its transaction) past its
  -- expiry has lost the lease, whatever time the transaction started.
  RETURN FOUND
    AND held.state = 'leased'
    AND held.lease_token = p_lease_token
    AND held.lease_owner = p_lease_owner
    AND held.lease_expires_at > clock_timestamp()
    AND held.session_id = p_session_id
    AND held.user_id = p_user_id
    AND held.workspace_id = p_workspace_id
    AND EXISTS (
      SELECT 1 FROM ai.chat_runs AS runs
      WHERE runs.run_id = p_run_id
        AND runs.session_id = p_session_id
        AND runs.request_id = held.chat_request_id
    );
END;
$$;

REVOKE ALL ON FUNCTION ai.assert_chat_run_dispatch_lease(UUID, UUID, TEXT, UUID, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai.assert_chat_run_dispatch_lease(UUID, UUID, TEXT, UUID, UUID, TEXT) TO backend_app;

-- Standalone personal provider keys (apps/backend/src/chat/runs/standaloneCredential.ts). The API seals the
-- key (AES-256-GCM, operator key file outside the database, AAD bound to instance/run/session/user/workspace/
-- expiry) and stores only ciphertext here, apart from the dispatch row and never readable by the runtime
-- role. The worker takes it inside its claim transaction after the lease assertion; taking deletes it.
-- Completion, recovery settlement and run/session deletion cascade it away; expired rows are purged.
ALTER TABLE ai.chat_run_dispatches
  ADD COLUMN requires_user_credential BOOLEAN NOT NULL DEFAULT false;
GRANT INSERT (requires_user_credential) ON ai.chat_run_dispatches TO backend_app;

CREATE TABLE ai.chat_run_dispatch_credentials (
  run_id        UUID        PRIMARY KEY REFERENCES ai.chat_run_dispatches(run_id) ON DELETE CASCADE,
  session_id    UUID        NOT NULL,
  user_id       TEXT        NOT NULL,
  workspace_id  UUID        NOT NULL,
  key_id        TEXT        NOT NULL CHECK (key_id ~ '^[0-9a-f]{16}$'),
  nonce         BYTEA       NOT NULL CHECK (octet_length(nonce) = 12),
  ciphertext    BYTEA       NOT NULL CHECK (octet_length(ciphertext) BETWEEN 17 AND 2048),
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT chat_run_dispatch_credentials_short_lived
    CHECK (expires_at > created_at AND expires_at <= created_at + interval '15 minutes')
);

CREATE INDEX idx_chat_run_dispatch_credentials_expiry
  ON ai.chat_run_dispatch_credentials(expires_at, run_id);

ALTER TABLE ai.chat_run_dispatch_credentials ENABLE ROW LEVEL SECURITY;

-- Same proof as the dispatch insert (0255): the request's own queued run, under its session's identity.
CREATE POLICY chat_run_dispatch_credentials_scoped_insert_runtime
  ON ai.chat_run_dispatch_credentials FOR INSERT TO backend_app
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM ai.chat_runs AS chat_runs
      JOIN ai.chat_sessions AS chat_sessions ON chat_sessions.session_id = chat_runs.session_id
      WHERE chat_runs.run_id = chat_run_dispatch_credentials.run_id
        AND chat_runs.session_id = chat_run_dispatch_credentials.session_id
        AND chat_runs.status = 'queued'
        AND chat_sessions.user_id = chat_run_dispatch_credentials.user_id
        AND chat_sessions.workspace_id = chat_run_dispatch_credentials.workspace_id
        AND chat_sessions.user_id = security.current_user_id()
        AND security.current_workspace_access_allowed(chat_sessions.workspace_id)
    )
  );

REVOKE ALL ON ai.chat_run_dispatch_credentials FROM PUBLIC, backend_app, auth_app, reporting_readonly;
GRANT INSERT (run_id, session_id, user_id, workspace_id, key_id, nonce, ciphertext, expires_at)
  ON ai.chat_run_dispatch_credentials TO backend_app;

-- Only the exact lease holder gets the ciphertext, and only once. `required` is true whenever the dispatch
-- was enqueued for a personal key or any credential row existed: the caller must then fail closed rather
-- than fall back to the operator key. Expired or mis-bound rows are deleted and returned without bytes.
CREATE FUNCTION ai.take_chat_run_dispatch_credential(
  p_run_id UUID, p_session_id UUID, p_user_id TEXT, p_workspace_id UUID,
  p_lease_token UUID, p_lease_owner TEXT)
RETURNS TABLE (required BOOLEAN, key_id TEXT, nonce BYTEA, ciphertext BYTEA, expires_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  flagged BOOLEAN;
  taken ai.chat_run_dispatch_credentials%ROWTYPE;
BEGIN
  IF NOT ai.assert_chat_run_dispatch_lease(
    p_run_id, p_session_id, p_user_id, p_workspace_id, p_lease_token, p_lease_owner)
  THEN
    RAISE EXCEPTION 'chat run dispatch lease is not held' USING ERRCODE = '55000';
  END IF;

  SELECT dispatches.requires_user_credential INTO flagged
  FROM ai.chat_run_dispatches AS dispatches
  WHERE dispatches.run_id = p_run_id;

  DELETE FROM ai.chat_run_dispatch_credentials AS credentials
  WHERE credentials.run_id = p_run_id
  RETURNING credentials.* INTO taken;

  required := flagged OR FOUND;
  IF FOUND
    AND taken.session_id = p_session_id
    AND taken.user_id = p_user_id
    AND taken.workspace_id = p_workspace_id
    AND taken.expires_at > clock_timestamp()
  THEN
    key_id := taken.key_id;
    nonce := taken.nonce;
    ciphertext := taken.ciphertext;
    expires_at := taken.expires_at;
  END IF;
  RETURN NEXT;
END;
$$;

CREATE FUNCTION ai.purge_expired_chat_run_dispatch_credentials(p_limit INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  purged INTEGER;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'p_limit must be between 1 and 1000' USING ERRCODE = '22023';
  END IF;
  WITH expired AS (
    SELECT credentials.run_id
    FROM ai.chat_run_dispatch_credentials AS credentials
    WHERE credentials.expires_at <= clock_timestamp()
    ORDER BY credentials.expires_at, credentials.run_id
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  )
  DELETE FROM ai.chat_run_dispatch_credentials AS credentials
  USING expired
  WHERE credentials.run_id = expired.run_id;
  GET DIAGNOSTICS purged = ROW_COUNT;
  RETURN purged;
END;
$$;

REVOKE ALL ON FUNCTION ai.take_chat_run_dispatch_credential(UUID, UUID, TEXT, UUID, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION ai.purge_expired_chat_run_dispatch_credentials(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai.take_chat_run_dispatch_credential(UUID, UUID, TEXT, UUID, UUID, TEXT) TO backend_app;
GRANT EXECUTE ON FUNCTION ai.purge_expired_chat_run_dispatch_credentials(INTEGER) TO backend_app;
