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
      rejectUnauthorized: false, // Maximum compatibility
    },
    requireTLS,
    ...(config.connectionTimeout ? { connectionTimeout: config.connectionTimeout } : {}),
  });
}
