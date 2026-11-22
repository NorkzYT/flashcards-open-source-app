-- Schemas touched/read explicitly: ai, security, pg_catalog.
-- Durable dispatch for the standalone (NIBOMO_DEPLOYMENT=standalone) chat worker; AWS keeps Lambda dispatch.
-- A row is inserted in the same transaction as its queued run and carries identifiers only: no message
-- content and no provider key. The worker leases it, then claims the run through the unchanged
-- ai.chat_runs claim fence. A run that left 'queued' may already have reached the provider, so recovery
-- never makes it claimable again; it hands it back for interruption instead.

CREATE TABLE ai.chat_run_dispatches (
  run_id            UUID        PRIMARY KEY REFERENCES ai.chat_runs(run_id) ON DELETE CASCADE,
  session_id        UUID        NOT NULL REFERENCES ai.chat_sessions(session_id) ON DELETE CASCADE,
  user_id           TEXT        NOT NULL,
  workspace_id      UUID        NOT NULL,
  chat_request_id   TEXT        NOT NULL,
  state             TEXT        NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'leased')),
  attempt_count     INTEGER     NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_token       UUID,
  lease_owner       TEXT,
  lease_expires_at  TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT chat_run_dispatches_state_shape CHECK (
    (state = 'pending' AND lease_token IS NULL AND lease_owner IS NULL AND lease_expires_at IS NULL)
    OR (
      state = 'leased'
      AND lease_token IS NOT NULL
      AND lease_expires_at IS NOT NULL
      AND lease_owner IS NOT NULL
      AND lease_owner = btrim(lease_owner)
      AND char_length(lease_owner) BETWEEN 1 AND 200
      AND lease_owner !~ '[[:cntrl:]]'
    )
  )
);

CREATE INDEX idx_chat_run_dispatches_pending
  ON ai.chat_run_dispatches(created_at, run_id) WHERE state = 'pending';
CREATE INDEX idx_chat_run_dispatches_lease_expiry
  ON ai.chat_run_dispatches(lease_expires_at, run_id) WHERE state = 'leased';

ALTER TABLE ai.chat_run_dispatches ENABLE ROW LEVEL SECURITY;

-- The request may enqueue only its own queued run, under the identity of the session that owns it.
CREATE POLICY chat_run_dispatches_scoped_insert_runtime
  ON ai.chat_run_dispatches FOR INSERT TO backend_app
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM ai.chat_runs AS chat_runs
      JOIN ai.chat_sessions AS chat_sessions ON chat_sessions.session_id = chat_runs.session_id
      WHERE chat_runs.run_id = chat_run_dispatches.run_id
        AND chat_runs.session_id = chat_run_dispatches.session_id
        AND chat_runs.request_id = chat_run_dispatches.chat_request_id
        AND chat_runs.status = 'queued'
        AND chat_sessions.user_id = chat_run_dispatches.user_id
        AND chat_sessions.workspace_id = chat_run_dispatches.workspace_id
        AND chat_sessions.user_id = security.current_user_id()
        AND security.current_workspace_access_allowed(chat_sessions.workspace_id)
    )
  );

-- Schema ai grants backend_app full DML on new tables by default (0032); narrow it to the enqueue insert.
REVOKE ALL ON ai.chat_run_dispatches FROM PUBLIC, backend_app, auth_app, reporting_readonly;
GRANT INSERT (run_id, session_id, user_id, workspace_id, chat_request_id)
  ON ai.chat_run_dispatches TO backend_app;

CREATE FUNCTION ai.lease_chat_run_dispatches(
  p_lease_owner TEXT, p_lease_duration_ms INTEGER, p_limit INTEGER)
RETURNS TABLE (
  run_id UUID, session_id UUID, user_id TEXT, workspace_id UUID,
  chat_request_id TEXT, lease_token UUID, attempt_count INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
#variable_conflict use_column
BEGIN
  IF p_lease_owner IS NULL OR p_lease_owner IS DISTINCT FROM btrim(p_lease_owner)
    OR char_length(p_lease_owner) NOT BETWEEN 1 AND 200 OR p_lease_owner ~ '[[:cntrl:]]'
  THEN
    RAISE EXCEPTION 'p_lease_owner must be 1 to 200 trimmed characters' USING ERRCODE = '22023';
  END IF;
  IF p_lease_duration_ms IS NULL OR p_lease_duration_ms NOT BETWEEN 1000 AND 600000 THEN
    RAISE EXCEPTION 'p_lease_duration_ms must be between 1000 and 600000' USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 64 THEN
    RAISE EXCEPTION 'p_limit must be between 1 and 64' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH claimable AS (
    SELECT dispatches.run_id
    FROM ai.chat_run_dispatches AS dispatches
    WHERE dispatches.state = 'pending'
    ORDER BY dispatches.created_at, dispatches.run_id
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  )
  UPDATE ai.chat_run_dispatches AS dispatches
  SET state = 'leased',
      attempt_count = dispatches.attempt_count + 1,
      lease_token = gen_random_uuid(),
      lease_owner = p_lease_owner,
      lease_expires_at = statement_timestamp() + (p_lease_duration_ms * interval '1 millisecond'),
      updated_at = statement_timestamp()
  FROM claimable
  WHERE dispatches.run_id = claimable.run_id
  RETURNING dispatches.run_id, dispatches.session_id, dispatches.user_id, dispatches.workspace_id,
    dispatches.chat_request_id, dispatches.lease_token, dispatches.attempt_count;
END;
$$;

-- Removes the row once its holder is done with the run, whatever the run's outcome.
CREATE FUNCTION ai.complete_chat_run_dispatch(p_run_id UUID, p_lease_token UUID)
RETURNS BOOLEAN
LANGUAGE SQL
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  WITH removed AS (
    DELETE FROM ai.chat_run_dispatches
    WHERE run_id = p_run_id AND state = 'leased' AND lease_token = p_lease_token
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM removed);
$$;

-- Classifies expired leases by the run's own state:
--   requeued  - the run is still 'queued' (never claimed) and attempts remain: claimable again;
--   exhausted - still 'queued' with no attempts left: re-leased to p_lease_owner for interruption;
--   ambiguous - the run left 'queued' and its heartbeat is stale: it may have reached the provider, so it
--               is re-leased to p_lease_owner for interruption and never made claimable;
--   settled   - the run is terminal: the row is removed.
-- A claimed run with a fresh heartbeat is still owned by its worker; its lease is extended silently.
CREATE FUNCTION ai.recover_chat_run_dispatches(
  p_lease_owner TEXT, p_max_attempts INTEGER, p_stale_heartbeat_ms INTEGER,
  p_lease_duration_ms INTEGER, p_limit INTEGER)
RETURNS TABLE (
  run_id UUID, session_id UUID, user_id TEXT, workspace_id UUID,
  chat_request_id TEXT, outcome TEXT, lease_token UUID, attempt_count INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  candidate RECORD;
  next_token UUID;
BEGIN
  IF p_lease_owner IS NULL OR p_lease_owner IS DISTINCT FROM btrim(p_lease_owner)
    OR char_length(p_lease_owner) NOT BETWEEN 1 AND 200 OR p_lease_owner ~ '[[:cntrl:]]'
  THEN
    RAISE EXCEPTION 'p_lease_owner must be 1 to 200 trimmed characters' USING ERRCODE = '22023';
  END IF;
  IF p_max_attempts IS NULL OR p_max_attempts NOT BETWEEN 1 AND 10 THEN
    RAISE EXCEPTION 'p_max_attempts must be between 1 and 10' USING ERRCODE = '22023';
  END IF;
  IF p_stale_heartbeat_ms IS NULL OR p_stale_heartbeat_ms NOT BETWEEN 1000 AND 600000 THEN
    RAISE EXCEPTION 'p_stale_heartbeat_ms must be between 1000 and 600000' USING ERRCODE = '22023';
  END IF;
  IF p_lease_duration_ms IS NULL OR p_lease_duration_ms NOT BETWEEN 1000 AND 600000 THEN
    RAISE EXCEPTION 'p_lease_duration_ms must be between 1000 and 600000' USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'p_limit must be between 1 and 100' USING ERRCODE = '22023';
  END IF;

  FOR candidate IN
    SELECT dispatches.run_id, dispatches.session_id, dispatches.user_id, dispatches.workspace_id,
      dispatches.chat_request_id, dispatches.attempt_count,
      runs.status AS run_status, runs.worker_heartbeat_at
    FROM ai.chat_run_dispatches AS dispatches
    JOIN ai.chat_runs AS runs ON runs.run_id = dispatches.run_id
    WHERE dispatches.state = 'leased' AND dispatches.lease_expires_at <= statement_timestamp()
    ORDER BY dispatches.lease_expires_at, dispatches.run_id
    FOR UPDATE OF dispatches SKIP LOCKED
    LIMIT p_limit
  LOOP
    run_id := candidate.run_id;
    session_id := candidate.session_id;
    user_id := candidate.user_id;
    workspace_id := candidate.workspace_id;
    chat_request_id := candidate.chat_request_id;
    attempt_count := candidate.attempt_count;
    lease_token := NULL;

    IF candidate.run_status = 'queued' AND candidate.attempt_count < p_max_attempts THEN
      UPDATE ai.chat_run_dispatches AS dispatches
      SET state = 'pending', lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL,
          updated_at = statement_timestamp()
      WHERE dispatches.run_id = candidate.run_id;
      outcome := 'requeued';
    ELSIF candidate.run_status = 'queued'
      OR (
        candidate.run_status = 'running'
        AND (
          candidate.worker_heartbeat_at IS NULL
          OR candidate.worker_heartbeat_at
            <= statement_timestamp() - (p_stale_heartbeat_ms * interval '1 millisecond')
        )
      )
    THEN
      next_token := gen_random_uuid();
      UPDATE ai.chat_run_dispatches AS dispatches
      SET lease_token = next_token, lease_owner = p_lease_owner,
          lease_expires_at = statement_timestamp() + (p_lease_duration_ms * interval '1 millisecond'),
          updated_at = statement_timestamp()
      WHERE dispatches.run_id = candidate.run_id;
      lease_token := next_token;
      outcome := CASE WHEN candidate.run_status = 'queued' THEN 'exhausted' ELSE 'ambiguous' END;
    ELSIF candidate.run_status = 'running' THEN
      UPDATE ai.chat_run_dispatches AS dispatches
      SET lease_expires_at = statement_timestamp() + (p_stale_heartbeat_ms * interval '1 millisecond'),
          updated_at = statement_timestamp()
      WHERE dispatches.run_id = candidate.run_id;
      CONTINUE;
    ELSE
      DELETE FROM ai.chat_run_dispatches AS dispatches WHERE dispatches.run_id = candidate.run_id;
      outcome := 'settled';
    END IF;
    RETURN NEXT;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION ai.lease_chat_run_dispatches(TEXT, INTEGER, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION ai.complete_chat_run_dispatch(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION ai.recover_chat_run_dispatches(TEXT, INTEGER, INTEGER, INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai.lease_chat_run_dispatches(TEXT, INTEGER, INTEGER) TO backend_app;
GRANT EXECUTE ON FUNCTION ai.complete_chat_run_dispatch(UUID, UUID) TO backend_app;
GRANT EXECUTE ON FUNCTION ai.recover_chat_run_dispatches(TEXT, INTEGER, INTEGER, INTEGER, INTEGER) TO backend_app;
