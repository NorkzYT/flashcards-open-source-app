import { readFileSync } from "node:fs";

/**
 * Standalone (self-hosted) email identity. `AUTH_IDENTITY_PROVIDER` is unset or `cognito` for the AWS
 * deployment, whose behavior does not change. `local` is an explicit opt-in that replaces only the
 * Cognito email-OTP boundary; any other value refuses to start. Decisions: docs/self-hosting.md.
 */
export type IdentityProviderMode = "cognito" | "local";

export type SmtpTlsMode = "implicit" | "starttls" | "none";

export type LocalIdentityConfig = Readonly<{
  issuer: string;
  audience: string;
  signingKeyPem: string;
  allowedEmails: ReadonlySet<string>;
  allowedEmailDomains: ReadonlySet<string>;
  idTokenTtlSeconds: number;
  refreshIdleTtlSeconds: number;
  refreshAbsoluteTtlSeconds: number;
  smtp: Readonly<{
    host: string;
    port: number;
    tlsMode: SmtpTlsMode;
    user: string | null;
    password: string | null;
    from: string;
  }>;
}>;

const ID_TOKEN_TTL_SECONDS = 3_600;
const REFRESH_IDLE_TTL_SECONDS = 30 * 86_400;
const REFRESH_ABSOLUTE_TTL_SECONDS = 365 * 86_400;

let resolvedConfig: LocalIdentityConfig | undefined;

export function getIdentityProviderMode(): IdentityProviderMode {
  const value = process.env.AUTH_IDENTITY_PROVIDER ?? "";
  if (value === "" || value === "cognito") return "cognito";
  if (value === "local") return "local";
  throw new Error(`AUTH_IDENTITY_PROVIDER must be "cognito" or "local", got "${value}"`);
}

function required(name: string): string {
  const value = (process.env[name] ?? "").trim();
  if (value === "") throw new Error(`${name} is required when AUTH_IDENTITY_PROVIDER=local`);
  return value;
}

function readSecretFile(name: string): string {
  const path = required(name);
  const contents = readFileSync(path, "utf8").trim();
  if (contents === "") throw new Error(`${name} points to an empty file`);
  return contents;
}

function parseList(value: string | undefined): ReadonlySet<string> {
  return new Set((value ?? "").split(",").map((item) => item.trim().toLowerCase()).filter((item) => item !== ""));
}

function parseHttpsOrigin(name: string): string {
  const raw = required(name);
  const url = new URL(raw);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "localhost")) {
    throw new Error(`${name} must be an https origin (http is accepted only for localhost)`);
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error(`${name} must be an origin without path, query or fragment`);
  }
  return url.origin;
}

function parseSmtpTlsMode(): SmtpTlsMode {
  const value = (process.env.SMTP_TLS_MODE ?? "starttls").trim();
  if (value === "implicit" || value === "starttls") return value;
  if (value === "none") {
    // Plaintext SMTP exists only for the isolated development mailbox profile; it carries OTPs.
    if (process.env.LOCAL_AUTH_DEV_MAILBOX !== "true") {
      throw new Error('SMTP_TLS_MODE=none requires LOCAL_AUTH_DEV_MAILBOX=true and is for test mailboxes only');
    }
    return value;
  }
  throw new Error(`SMTP_TLS_MODE must be "implicit", "starttls" or "none", got "${value}"`);
}

export function getLocalIdentityConfig(): LocalIdentityConfig {
  if (resolvedConfig !== undefined) return resolvedConfig;
  const allowedEmails = parseList(process.env.LOCAL_AUTH_ALLOWED_EMAILS);
  const allowedEmailDomains = parseList(process.env.LOCAL_AUTH_ALLOWED_EMAIL_DOMAINS);
  if (allowedEmails.size === 0 && allowedEmailDomains.size === 0) {
    // No open registration: an operator names who may create an account.
    throw new Error("LOCAL_AUTH_ALLOWED_EMAILS or LOCAL_AUTH_ALLOWED_EMAIL_DOMAINS must name at least one account");
  }
  const port = Number.parseInt(required("SMTP_PORT"), 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error("SMTP_PORT must be a TCP port");
  const user = (process.env.SMTP_USER ?? "").trim();
  // The password file is read only when a user is configured, and must then be non-empty.
  const password = user === "" ? null : readSecretFile("SMTP_PASSWORD_FILE");
  const audience = required("LOCAL_AUTH_CLIENT_ID");
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(audience)) throw new Error("LOCAL_AUTH_CLIENT_ID must be 16-128 URL-safe characters");
  resolvedConfig = {
    issuer: parseHttpsOrigin("LOCAL_AUTH_ISSUER"),
    audience,
    signingKeyPem: readSecretFile("LOCAL_AUTH_SIGNING_KEY_FILE"),
    allowedEmails,
    allowedEmailDomains,
    idTokenTtlSeconds: ID_TOKEN_TTL_SECONDS,
    refreshIdleTtlSeconds: REFRESH_IDLE_TTL_SECONDS,
    refreshAbsoluteTtlSeconds: REFRESH_ABSOLUTE_TTL_SECONDS,
    smtp: {
      host: required("SMTP_HOST"),
      port,
      tlsMode: parseSmtpTlsMode(),
      user: user === "" ? null : user,
      password,
      from: required("SMTP_FROM"),
    },
  };
  return resolvedConfig;
}

export function isEmailAllowedToRegister(config: LocalIdentityConfig, email: string): boolean {
  const domain = email.slice(email.lastIndexOf("@") + 1);
  return config.allowedEmails.has(email) || config.allowedEmailDomains.has(domain);
}

export function resetLocalIdentityConfigForTests(): void {
  resolvedConfig = undefined;
}
