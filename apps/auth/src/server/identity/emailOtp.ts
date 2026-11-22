import * as cognito from "../cognito/cognitoAuth.js";
import { assertNewlyIssuedSessionToken, verifiedBrowserSession } from "../browserSession.js";
import { getIdentityProviderMode } from "../local/localIdentityConfig.js";
import {
  initiateLocalEmailOtp,
  LocalRefreshRejectedError,
  refreshLocalTokens,
  revokeLocalToken,
  verifyLocalEmailOtp,
} from "../local/localEmailOtp.js";
import { PrincipalSessionError } from "../social/principalSessions.js";

/**
 * The email-OTP and token-lifecycle boundary used by the browser and agent routes. Cognito stays the
 * default; AUTH_IDENTITY_PROVIDER=local selects the standalone provider. Route contracts are identical.
 */
export type TokenResult = cognito.TokenResult;

export const initiateEmailOtp = async (email: string): Promise<Readonly<{ session: string }>> =>
  getIdentityProviderMode() === "local" ? initiateLocalEmailOtp(email) : cognito.initiateEmailOtp(email);

export const verifyEmailOtp = async (email: string, code: string, session: string): Promise<TokenResult> => {
  if (getIdentityProviderMode() !== "local") return cognito.verifyEmailOtp(email, code, session);
  const tokens = await verifyLocalEmailOtp(email, code, session);
  return { ...tokens, [verifiedBrowserSession]: await assertNewlyIssuedSessionToken(tokens.idToken) };
};

export const signInWithPassword = async (email: string, password: string): Promise<TokenResult> => {
  // Shared review-account passwords are a Cognito feature; the standalone provider has none.
  if (getIdentityProviderMode() === "local") throw new Error("Password sign-in is unavailable with the local identity provider");
  return cognito.signInWithPassword(email, password);
};

export const refreshTokens: typeof cognito.refreshTokens = async (refreshToken) => {
  if (getIdentityProviderMode() !== "local") return cognito.refreshTokens(refreshToken);
  const tokens = await refreshLocalTokens(refreshToken);
  await assertNewlyIssuedSessionToken(tokens.idToken);
  return tokens;
};

export function isTerminalRefreshFailure(error: unknown): boolean {
  if (error instanceof LocalRefreshRejectedError) return true;
  if (error instanceof PrincipalSessionError) return error.statusCode !== 503;
  return cognito.isTerminalRefreshFailure(error);
}

export const revokeToken = async (refreshToken: string): Promise<void> =>
  getIdentityProviderMode() === "local" ? revokeLocalToken(refreshToken) : cognito.revokeToken(refreshToken);
