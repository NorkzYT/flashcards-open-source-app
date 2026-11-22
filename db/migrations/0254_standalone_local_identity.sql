-- Schemas touched/read explicitly: auth.
-- Standalone (self-hosted) email identity used only when the auth service runs with
-- AUTH_IDENTITY_PROVIDER=local (docs/self-hosting.md). AWS deployments keep Cognito and leave these
-- tables empty. Subjects map to product accounts through auth.user_identities like Cognito subjects.

CREATE TABLE auth.local_identities (
  subject UUID PRIMARY KEY,
  email TEXT NOT NULL UNIQUE CHECK (email = lower(btrim(email)) AND position('@' IN email) > 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  disabled_at TIMESTAMPTZ
);

-- One row per sent (or deliberately unsent, for an address that may not register) code. Only HMACs
-- of the code and the client-held challenge secret are stored.
CREATE TABLE auth.local_email_otp_challenges (
  challenge_id UUID PRIMARY KEY,
  email TEXT NOT NULL CHECK (email = lower(btrim(email))),
  secret_hmac TEXT NOT NULL CHECK (secret_hmac ~ '^[0-9a-f]{64}$'),
  code_hmac TEXT NOT NULL CHECK (code_hmac ~ '^[0-9a-f]{64}$'),
  may_register BOOLEAN NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);
CREATE INDEX ON auth.local_email_otp_challenges (expires_at);

-- Opaque refresh tokens: only a SHA-256 of the 256-bit random token is stored. Expiry rolls on use
-- up to an absolute limit; revocation is immediate.
CREATE TABLE auth.local_refresh_tokens (
  token_sha256 TEXT PRIMARY KEY CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  subject UUID NOT NULL REFERENCES auth.local_identities (subject) ON DELETE CASCADE,
  auth_time BIGINT NOT NULL CHECK (auth_time >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  idle_expires_at TIMESTAMPTZ NOT NULL,
  absolute_expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX ON auth.local_refresh_tokens (subject);
CREATE INDEX ON auth.local_refresh_tokens (idle_expires_at);

REVOKE ALL ON auth.local_identities, auth.local_email_otp_challenges, auth.local_refresh_tokens
  FROM PUBLIC, backend_app, reporting_readonly;
GRANT SELECT, INSERT, UPDATE ON auth.local_identities TO auth_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON auth.local_email_otp_challenges TO auth_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON auth.local_refresh_tokens TO auth_app;
