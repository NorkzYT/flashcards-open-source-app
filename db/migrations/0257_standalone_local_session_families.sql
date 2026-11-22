-- Schemas touched/read explicitly: auth, pg_catalog.
-- Standalone (AUTH_IDENTITY_PROVIDER=local) session families: one row per sign-in, the revocation
-- authority for every ID token (`sid` claim) and refresh token issued from it. Refresh tokens rotate
-- atomically; presenting a rotated token outside the retry grace revokes the whole family. Contract:
-- apps/auth/src/server/local/localEmailOtp.ts, docs/auth-service.md. AWS deployments leave these empty.

SET LOCAL lock_timeout = '30s';

CREATE TABLE auth.local_session_families (
  family_id UUID PRIMARY KEY,
  subject UUID NOT NULL REFERENCES auth.local_identities (subject) ON DELETE CASCADE,
  -- The deployment the family was issued for; a later issuer/audience change orphans it.
  issuer TEXT NOT NULL CHECK (issuer <> ''),
  audience TEXT NOT NULL CHECK (audience <> ''),
  auth_time BIGINT NOT NULL CHECK (auth_time >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  absolute_expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  revoke_reason TEXT CHECK (revoke_reason IN ('logout', 'refresh_reuse')),
  CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
);
CREATE INDEX ON auth.local_session_families (subject);
CREATE INDEX ON auth.local_session_families (absolute_expires_at);

ALTER TABLE auth.local_refresh_tokens
  ADD COLUMN family_id UUID REFERENCES auth.local_session_families (family_id) ON DELETE CASCADE,
  ADD COLUMN rotated_at TIMESTAMPTZ,
  ADD COLUMN successor_sha256 TEXT CHECK (successor_sha256 ~ '^[0-9a-f]{64}$'),
  ADD CHECK ((rotated_at IS NULL) = (successor_sha256 IS NULL));

-- 0254 tokens were non-rotating and carry no family, so they cannot be bound to an ID token: those
-- sessions sign in again. Rows are kept (revoked) rather than deleted.
UPDATE auth.local_refresh_tokens SET revoked_at = clock_timestamp() WHERE family_id IS NULL AND revoked_at IS NULL;
ALTER TABLE auth.local_refresh_tokens ADD CHECK (family_id IS NOT NULL OR revoked_at IS NOT NULL);
CREATE INDEX ON auth.local_refresh_tokens (family_id);
-- At most one live refresh token per family.
CREATE UNIQUE INDEX local_refresh_tokens_one_current_per_family ON auth.local_refresh_tokens (family_id)
  WHERE rotated_at IS NULL AND revoked_at IS NULL;

REVOKE ALL ON auth.local_session_families FROM PUBLIC, backend_app, reporting_readonly;
GRANT SELECT, INSERT, UPDATE, DELETE ON auth.local_session_families TO auth_app;

-- The only standalone session read the backend gets: a status for one signed (sid, sub, iss, aud).
-- No secret, digest or row is returned.
CREATE FUNCTION auth.local_session_status(target_family UUID, target_subject TEXT, target_issuer TEXT, target_audience TEXT)
RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM auth.local_session_families AS family
      JOIN auth.local_identities AS identity ON identity.subject = family.subject
     WHERE family.family_id = target_family
       AND family.subject::TEXT = target_subject
       AND family.issuer = target_issuer
       AND family.audience = target_audience
       AND family.revoked_at IS NULL
       AND family.absolute_expires_at > pg_catalog.clock_timestamp()
       AND identity.disabled_at IS NULL
  ) THEN 'valid' ELSE 'revoked' END
$$;
REVOKE ALL ON FUNCTION auth.local_session_status(UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.local_session_status(UUID, TEXT, TEXT, TEXT) TO auth_app, backend_app;
