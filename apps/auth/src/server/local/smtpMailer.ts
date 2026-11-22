import nodemailer, { type Transporter } from "nodemailer";
import { getLocalIdentityConfig } from "./localIdentityConfig.js";

let transporter: Transporter | undefined;

function getTransporter(): Transporter {
  if (transporter !== undefined) return transporter;
  const { smtp } = getLocalIdentityConfig();
  transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    // implicit: TLS from the first byte; starttls: the upgrade is mandatory, never optional.
    secure: smtp.tlsMode === "implicit",
    requireTLS: smtp.tlsMode === "starttls",
    ignoreTLS: smtp.tlsMode === "none",
    auth: smtp.user === null || smtp.password === null ? undefined : { user: smtp.user, pass: smtp.password },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  return transporter;
}

/** Sends the sign-in code. The code never reaches logs; a delivery failure propagates to the route. */
export async function sendLocalSignInCode(email: string, code: string): Promise<void> {
  const { smtp } = getLocalIdentityConfig();
  await getTransporter().sendMail({
    from: smtp.from,
    to: email,
    subject: `Your Nibomo sign-in code: ${code}`,
    text: `Your Nibomo sign-in code is ${code}\n\nIt expires in 3 minutes. If you did not request it, ignore this email.\n`,
  });
}
