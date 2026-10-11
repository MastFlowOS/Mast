import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";

export interface SmtpConfig {
  host: string;
  port: number | string;
  user: string;
  pass: string;
  encryption?: string;
  connectionTimeout?: number;
}

export function createSmtpTransport(config: SmtpConfig): Transporter {
  const secure = config.encryption === "SSL";
  const requireTLS = config.encryption === "TLS";

  return nodemailer.createTransport({
    host: config.host,
    port: Number(config.port),
    secure,
    auth: {
      user: config.user,
      pass: config.pass,
    },
    tls: {
      // Validate SMTP server certificates by default. Only allow insecure TLS
      // for a deliberately configured private/self-signed relay.
      rejectUnauthorized: process.env.SMTP_ALLOW_INSECURE_TLS !== "true",
    },
    requireTLS,
    ...(config.connectionTimeout ? { connectionTimeout: config.connectionTimeout } : {}),
  });
}
