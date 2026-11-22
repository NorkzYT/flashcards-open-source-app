import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { type DatabaseExecutor, query, transaction } from "../../db.js";
import { keyedDigestHex } from "../crypto.js";
import { log } from "../logger.js";
import { getLocalIdentityConfig, isEmailAllowedToRegister } from "./localIdentityConfig.js";
import { issueLocalTokens } from "./localTokens.js";
import { sendLocalSignInCode } from "./smtpMailer.js";

/**
 * Email OTP for AUTH_IDENTITY_PROVIDER=local. Same public contract as the Cognito path: initiate
 * returns an opaque session string, verify returns id/access/refresh tokens. Error messages match the
 * classifier in routes/browser/verifyCode.ts, so existing throttles and lockouts apply unchanged.
 */
const OTP_TTL_SECONDS = 180;
const MAX_FAILED_ATTEMPTS = 5;
const SESSION_RE = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/;
const REFRESH_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
/**
 * A rotated refresh token may be presented again only within this window, and only while its
 * successor is still the family's current token: concurrent refreshes (two browser tabs, Android's
 * unlocked refresh) and a retry after a lost response then receive the same successor. Any other
 * reuse of a rotated token revokes the whole family.
 */
const ROTATION_RETRY_GRACE_SECONDS = 60;

export class LocalRefreshRejectedError extends Error {
  constructor(reason: string) {
    super(`Local refresh token rejected: ${reason}`);
    this.name = "LocalRefreshRejectedError";
  }
}

const secretDigest = (challengeId: string, secret: string): string => keyedDigestHex("local-otp-session", `${challengeId}:${secret}`);
const codeDigest = (challengeId: string, code: string): string => keyedDigestHex("local-otp-code", `${challengeId}:${code}`);
const refreshDigest = (token: string): string => createHash("sha256").update(token).digest("hex");
/** Successor of a refresh token: 256-bit keyed derivation, so a retried rotation is idempotent. */
const successorToken = (token: string): string =>
  Buffer.from(keyedDigestHex("local-refresh-rotate", token), "hex").toString("base64url");

function sameHex(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function initiateLocalEmailOtp(email: string): Promise<Readonly<{ session: string }>> {
  const config = getLocalIdentityConfig();
  const existing = await query<{ disabled: boolean }>(
    "SELECT disabled_at IS NOT NULL AS disabled FROM auth.local_identities WHERE email = $1",
    [email],
  );
  const identity = existing.rows[0];
  const mayRegister = identity === undefined ? isEmailAllowedToRegister(config, email) : !identity.disabled;
  const challengeId = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  const code = randomInt(0, 100_000_000).toString().padStart(8, "0");
  await query(
    `INSERT INTO auth.local_email_otp_challenges
       (challenge_id, email, secret_hmac, code_hmac, may_register, expires_at)
     VALUES ($1, $2, $3, $4, $5, clock_timestamp() + make_interval(secs => $6))`,
    [challengeId, email, secretDigest(challengeId, secret), codeDigest(challengeId, code), mayRegister, OTP_TTL_SECONDS],
  );
  if (mayRegister) {
    // Not awaited: response time and status must not reveal whether an address may sign in. A
    // delivery failure is logged (never with the code) and the person requests a new code.
    void sendLocalSignInCode(email, code).catch((error: unknown) => {
      log({ domain: "auth", action: "send_code_error", reasonCategory: "local_smtp_delivery_failed", email,
        error: error instanceof Error ? error.message : String(error) });
    });
  } else {
    // Indistinguishable to the caller: no mail is sent, and every code is rejected as invalid.
    log({ domain: "auth", action: "send_code", reasonCategory: "local_identity_not_allowed", email });
  }
  await purgeExpiredLocalIdentityRows();
  return { session: `${challengeId}.${secret}` };
}

const PURGE_BATCH = 200;

/**
 * Bounded, opportunistic retention: dead challenges after a day; rotated or dead refresh tokens and
 * dead families after 30 days (a rotated token older than that is rejected as unknown, not as reuse).
 */
async function purgeExpiredLocalIdentityRows(): Promise<void> {
  await query(
    `DELETE FROM auth.local_email_otp_challenges WHERE challenge_id IN (
       SELECT challenge_id FROM auth.local_email_otp_challenges
        WHERE expires_at < clock_timestamp() - INTERVAL '1 day' LIMIT $1)`,
    [PURGE_BATCH],
  );
  await query(
    `DELETE FROM auth.local_refresh_tokens WHERE token_sha256 IN (
       SELECT token_sha256 FROM auth.local_refresh_tokens
        WHERE LEAST(idle_expires_at, absolute_expires_at, COALESCE(revoked_at, 'infinity'), COALESCE(rotated_at, 'infinity'))
              < clock_timestamp() - INTERVAL '30 days' LIMIT $1)`,
    [PURGE_BATCH],
  );
  await query(
    `DELETE FROM auth.local_session_families WHERE family_id IN (
       SELECT family_id FROM auth.local_session_families
        WHERE LEAST(absolute_expires_at, COALESCE(revoked_at, 'infinity')) < clock_timestamp() - INTERVAL '30 days' LIMIT $1)`,
    [PURGE_BATCH],
  );
}

type VerifyOutcome =
  | Readonly<{ status: "ok"; subject: string; authTime: number; familyId: string; refreshToken: string }>
  | Readonly<{ status: "failed"; message: string }>;

export async function verifyLocalEmailOtp(email: string, code: string, session: string): Promise<Readonly<{
  idToken: string; accessToken: string; refreshToken: string; expiresIn: number;
}>> {
  const config = getLocalIdentityConfig();
  const match = SESSION_RE.exec(session);
  if (match === null) throw new Error("Invalid session for the user");
  const challengeId = match[1] as string;
  const secret = match[2] as string;

  const outcome = await transaction<VerifyOutcome>(async (executor) => {
    const found = await executor.query<{
      email: string; secret_hmac: string; code_hmac: string; may_register: boolean;
      failed_attempts: number; expired: boolean; consumed: boolean;
    }>(
      `SELECT email, secret_hmac, code_hmac, may_register, failed_attempts,
              expires_at <= clock_timestamp() AS expired, consumed_at IS NOT NULL AS consumed
         FROM auth.local_email_otp_challenges WHERE challenge_id = $1 FOR UPDATE`,
      [challengeId],
    );
    const row = found.rows[0];
    if (row === undefined || row.email !== email || !sameHex(row.secret_hmac, secretDigest(challengeId, secret))) {
      return { status: "failed", message: "Invalid session for the user" };
    }
    if (row.consumed || row.failed_attempts >= MAX_FAILED_ATTEMPTS) {
      return { status: "failed", message: "Session can only be used once" };
    }
    if (row.expired) return { status: "failed", message: "Session expired" };
    if (!row.may_register || !sameHex(row.code_hmac, codeDigest(challengeId, code))) {
      await executor.query(
        `UPDATE auth.local_email_otp_challenges SET failed_attempts = failed_attempts + 1,
           consumed_at = CASE WHEN failed_attempts + 1 >= $2 THEN clock_timestamp() ELSE NULL END
         WHERE challenge_id = $1`,
        [challengeId, MAX_FAILED_ATTEMPTS],
      );
      return { status: "failed", message: "Invalid code" };
    }
    await executor.query(
      "UPDATE auth.local_email_otp_challenges SET consumed_at = clock_timestamp() WHERE challenge_id = $1",
      [challengeId],
    );
    await executor.query(
      "INSERT INTO auth.local_identities (subject, email) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING",
      [randomUUID(), email],
    );
    const identity = await executor.query<{ subject: string; disabled: boolean; now_seconds: string }>(
      `SELECT subject, disabled_at IS NOT NULL AS disabled, floor(extract(epoch FROM clock_timestamp()))::BIGINT AS now_seconds
         FROM auth.local_identities WHERE email = $1`,
      [email],
    );
    const identityRow = identity.rows[0];
    if (identityRow === undefined || identityRow.disabled) return { status: "failed", message: "Invalid code" };
    const authTime = Number(identityRow.now_seconds);
    const refreshToken = randomBytes(32).toString("base64url");
    const familyId = randomUUID();
    await executor.query(
      `INSERT INTO auth.local_session_families (family_id, subject, issuer, audience, auth_time, absolute_expires_at)
       VALUES ($1, $2, $3, $4, $5, clock_timestamp() + make_interval(secs => $6))`,
      [familyId, identityRow.subject, config.issuer, config.audience, authTime, config.refreshAbsoluteTtlSeconds],
    );
    await executor.query(
      `INSERT INTO auth.local_refresh_tokens
         (token_sha256, subject, auth_time, family_id, idle_expires_at, absolute_expires_at)
       SELECT $1, family.subject, family.auth_time, family.family_id,
              LEAST(family.absolute_expires_at, clock_timestamp() + make_interval(secs => $3)), family.absolute_expires_at
         FROM auth.local_session_families AS family WHERE family.family_id = $2`,
      [refreshDigest(refreshToken), familyId, config.refreshIdleTtlSeconds],
    );
    return { status: "ok", subject: identityRow.subject, authTime, familyId, refreshToken };
  });

  if (outcome.status === "failed") throw new Error(outcome.message);
  log({ domain: "auth", action: "verify_code", email });
  const tokens = issueLocalTokens(
    { subject: outcome.subject, email, authTime: outcome.authTime, familyId: outcome.familyId }, Math.floor(Date.now() / 1_000));
  return { ...tokens, refreshToken: outcome.refreshToken };
}

type RefreshOutcome =
  | Readonly<{ status: "ok"; subject: string; email: string; authTime: number; familyId: string; refreshToken: string; replay: boolean }>
  | Readonly<{ status: "rejected"; reason: string }>;

async function revokeFamily(executor: DatabaseExecutor, familyId: string, reason: "logout" | "refresh_reuse"): Promise<void> {
  await executor.query(
    `UPDATE auth.local_session_families SET revoked_at = clock_timestamp(), revoke_reason = $2
      WHERE family_id = $1 AND revoked_at IS NULL`,
    [familyId, reason],
  );
  await executor.query(
    "UPDATE auth.local_refresh_tokens SET revoked_at = clock_timestamp() WHERE family_id = $1 AND revoked_at IS NULL",
    [familyId],
  );
}

/**
 * Rotating refresh, same wire shape as a Cognito pool with rotation enabled: the response carries the
 * replacement `refreshToken`, which browser (`refresh-session` cookie) and native clients store. The
 * family row is locked, so concurrent refreshes of one family serialize. Reuse of a rotated token
 * outside ROTATION_RETRY_GRACE_SECONDS revokes the family, which also stops its ID tokens (`sid`).
 */
export async function refreshLocalTokens(refreshToken: string): Promise<Readonly<{
  idToken: string; accessToken: string; refreshToken: string; expiresIn: number;
}>> {
  if (!REFRESH_TOKEN_RE.test(refreshToken)) throw new LocalRefreshRejectedError("malformed");
  const config = getLocalIdentityConfig();
  const presented = refreshDigest(refreshToken);
  const successor = successorToken(refreshToken);
  const successorDigest = refreshDigest(successor);

  const outcome = await transaction<RefreshOutcome>(async (executor) => {
    // Lock the family first; the state is read by a later statement so that, under READ COMMITTED, a
    // refresh that waited on a concurrent rotation sees the committed successor (a single locking
    // SELECT would evaluate its subqueries on the pre-wait snapshot and misread a retry as reuse).
    const locked = await executor.query<{ family_id: string }>(
      `SELECT family.family_id FROM auth.local_session_families AS family
        WHERE family.family_id = (SELECT family_id FROM auth.local_refresh_tokens WHERE token_sha256 = $1)
        FOR UPDATE`,
      [presented],
    );
    if (locked.rows[0] === undefined) return { status: "rejected", reason: "unknown" };
    const found = await executor.query<{
      family_id: string; subject: string; email: string; auth_time: string; issuer: string; audience: string;
      rotated: boolean; within_grace: boolean; successor_sha256: string | null; successor_current: boolean;
      token_dead: boolean; family_dead: boolean; disabled: boolean;
    }>(
      `SELECT token.family_id, family.subject, identity.email, family.auth_time, family.issuer, family.audience,
              token.rotated_at IS NOT NULL AS rotated,
              COALESCE(token.rotated_at > clock_timestamp() - make_interval(secs => $2), FALSE) AS within_grace,
              token.successor_sha256,
              EXISTS (SELECT 1 FROM auth.local_refresh_tokens AS next
                       WHERE next.token_sha256 = token.successor_sha256 AND next.family_id = token.family_id
                         AND next.rotated_at IS NULL AND next.revoked_at IS NULL) AS successor_current,
              (token.revoked_at IS NOT NULL OR token.idle_expires_at <= clock_timestamp()
                 OR token.absolute_expires_at <= clock_timestamp()) AS token_dead,
              (family.revoked_at IS NOT NULL OR family.absolute_expires_at <= clock_timestamp()) AS family_dead,
              identity.disabled_at IS NOT NULL AS disabled
         FROM auth.local_refresh_tokens AS token
         JOIN auth.local_session_families AS family ON family.family_id = token.family_id
         JOIN auth.local_identities AS identity ON identity.subject = family.subject
        WHERE token.token_sha256 = $1`,
      [presented, ROTATION_RETRY_GRACE_SECONDS],
    );
    const row = found.rows[0];
    if (row === undefined) return { status: "rejected", reason: "unknown" };
    if (row.family_dead || row.disabled) return { status: "rejected", reason: "family revoked or expired" };
    if (row.issuer !== config.issuer || row.audience !== config.audience) {
      return { status: "rejected", reason: "issued for another deployment" };
    }
    const issued = {
      status: "ok", subject: row.subject, email: row.email, authTime: Number(row.auth_time), familyId: row.family_id,
      refreshToken: successor,
    } as const;
    if (row.rotated) {
      if (row.within_grace && row.successor_current && row.successor_sha256 === successorDigest) {
        return { ...issued, replay: true };
      }
      await revokeFamily(executor, row.family_id, "refresh_reuse");
      return { status: "rejected", reason: "reused after rotation" };
    }
    if (row.token_dead) return { status: "rejected", reason: "expired or revoked" };
    await executor.query(
      "UPDATE auth.local_refresh_tokens SET rotated_at = clock_timestamp(), last_used_at = clock_timestamp(), successor_sha256 = $2 WHERE token_sha256 = $1",
      [presented, successorDigest],
    );
    await executor.query(
      `INSERT INTO auth.local_refresh_tokens
         (token_sha256, subject, auth_time, family_id, idle_expires_at, absolute_expires_at)
       SELECT $1, family.subject, family.auth_time, family.family_id,
              LEAST(family.absolute_expires_at, clock_timestamp() + make_interval(secs => $3)), family.absolute_expires_at
         FROM auth.local_session_families AS family WHERE family.family_id = $2`,
      [successorDigest, row.family_id, config.refreshIdleTtlSeconds],
    );
    return { ...issued, replay: false };
  });

  if (outcome.status === "rejected") {
    log({ domain: "auth", action: "refresh_token_error", reasonCategory: `local_refresh_${outcome.reason.replaceAll(" ", "_")}` });
    throw new LocalRefreshRejectedError(outcome.reason);
  }
  log({ domain: "auth", action: "refresh_token", ...(outcome.replay ? { reasonCategory: "rotation_retry" } : {}) });
  const tokens = issueLocalTokens(
    { subject: outcome.subject, email: outcome.email, authTime: outcome.authTime, familyId: outcome.familyId },
    Math.floor(Date.now() / 1_000),
  );
  return { ...tokens, refreshToken: outcome.refreshToken };
}

/** Logout with any token of a family (current or rotated) ends the whole family, ID tokens included. */
export async function revokeLocalToken(refreshToken: string): Promise<void> {
  if (!REFRESH_TOKEN_RE.test(refreshToken)) return;
  await transaction(async (executor) => {
    const found = await executor.query<{ family_id: string | null }>(
      "SELECT family_id FROM auth.local_refresh_tokens WHERE token_sha256 = $1",
      [refreshDigest(refreshToken)],
    );
    const familyId = found.rows[0]?.family_id ?? null;
    if (familyId !== null) await revokeFamily(executor, familyId, "logout");
  });
  log({ domain: "auth", action: "revoke_token" });
}
