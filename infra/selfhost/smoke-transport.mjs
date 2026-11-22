// Gateway transport for the self-host smokes. `url` names the logical target: its host is sent as
// the Host header and, over https, as TLS SNI, while the connection goes to SMOKE_GATEWAY (or to the
// URL itself without a gateway). Certificates are always verified against the explicit test CA
// (SMOKE_CA_FILE) or, when that is unset, the system store. There is no way to skip verification.
// Response text and error messages pass through `redact`, so callers can put them in assertions.
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";

export function refuseInsecureTls(env = process.env) {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw new Error("NODE_TLS_REJECT_UNAUTHORIZED=0 is refused: supply the test CA with SMOKE_CA_FILE");
  }
}

export const readCa = (caFile) => (caFile === undefined || caFile === "" ? undefined : readFileSync(caFile));

// Credentials the auth, API and MCP services hand out, and the OAuth/OTP values that unlock them.
export const redact = (text) => String(text)
  .replace(/(Bearer )[A-Za-z0-9_.~+/=-]+/g, "$1<redacted>")
  .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "<jwt>")
  .replace(/\bfc[a-z]_[A-Za-z0-9_.~-]+/g, (match) => `${match.slice(0, 4)}<redacted>`)
  .replace(/("(?:refreshToken|idToken|apiKey|otpSessionToken|csrfToken|code|code_verifier|access_token|refresh_token|id_token|client_secret|redirect_to)"\s*:\s*")[^"]*/g, "$1<redacted>")
  .replace(/([?&](?:code|code_verifier|refresh_token|access_token|X-Amz-(?:Signature|Credential|Security-Token)|uploadId)=)[^&\s"']*/gi, "$1<redacted>")
  .replace(/\b(session=)[^;\s"']+/g, "$1<redacted>");

export function createTransport({ gateway = "", ca } = {}) {
  const dialBase = gateway === "" ? undefined : new URL(gateway);
  if (dialBase !== undefined && dialBase.protocol !== "http:" && dialBase.protocol !== "https:") {
    throw new Error(`SMOKE_GATEWAY must be http:// or https://, got ${dialBase.protocol}`);
  }
  // `servername` overrides SNI only for probes that keep a verified connection but send another Host.
  function request(url, { method = "GET", host, servername, headers = {}, body, form, raw, timeoutMs = 60_000 } = {}) {
    const target = new URL(url);
    const publicHost = host ?? target.host;
    const dial = dialBase ?? target;
    const secure = dial.protocol === "https:";
    let payload = raw;
    const extra = {};
    if (form !== undefined) {
      payload = Buffer.from(new URLSearchParams(form).toString());
      extra["content-type"] = "application/x-www-form-urlencoded";
    } else if (body !== undefined) {
      payload = Buffer.from(JSON.stringify(body));
      extra["content-type"] = "application/json";
    }
    if (payload !== undefined) extra["content-length"] = payload.length;
    return new Promise((resolve, reject) => {
      const req = (secure ? https : http).request({
        protocol: dial.protocol,
        hostname: dial.hostname.replace(/^\[|\]$/g, ""),
        port: dial.port || (secure ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method,
        headers: { host: publicHost, ...extra, ...headers },
        ...(secure ? {
          servername: servername ?? publicHost.replace(/:\d+$/, ""),
          rejectUnauthorized: true,
          ...(ca === undefined ? {} : { ca }),
        } : {}),
        agent: false,
        timeout: timeoutMs,
      }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => { chunks.push(chunk); });
        res.on("end", () => {
          const bytes = Buffer.concat(chunks);
          const text = bytes.toString("utf8");
          let json = null;
          try { json = JSON.parse(text); } catch { /* not JSON */ }
          resolve({ status: res.statusCode, headers: res.headers, bytes, text: redact(text), json });
        });
      });
      // Only the path: queries carry PKCE challenges, codes and signatures.
      req.on("timeout", () => req.destroy(new Error(`timeout ${method} ${publicHost}${target.pathname}`)));
      req.on("error", (error) => {
        error.message = redact(error.message);
        reject(error);
      });
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }
  return { request, secure: (dialBase?.protocol ?? "") === "https:" };
}
