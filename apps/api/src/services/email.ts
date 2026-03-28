import { createTransport, type Transporter } from "nodemailer";
import { getEnv } from "@appstrate/env";
import { getAppConfig } from "../lib/app-config.ts";
import { logger } from "../lib/logger.ts";

const env = getEnv();

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

let transport: Transporter | null = null;

function getTransport(): Transporter {
  if (!transport) {
    transport = createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    });
  }
  return transport;
}

async function sendMail(to: string, subject: string, html: string): Promise<void> {
  if (!getAppConfig().features.smtp) return;
  try {
    await getTransport().sendMail({ from: env.SMTP_FROM, to, subject, html });
  } catch (err) {
    logger.error("Failed to send email", { err, to, subject });
  }
}

export async function sendInvitationEmail(opts: {
  email: string;
  token: string;
  orgName: string;
  inviterName: string;
  role: string;
}): Promise<void> {
  const inviteUrl = `${env.APP_URL}/invite/${opts.token}/accept`;
  const orgName = escapeHtml(opts.orgName);
  const inviterName = escapeHtml(opts.inviterName);
  const role = escapeHtml(opts.role);

  const html = `<p>${inviterName} vous invite à rejoindre l'organisation <strong>${orgName}</strong> en tant que <strong>${role}</strong>.</p>
<p><a href="${inviteUrl}">Accepter l'invitation</a></p>
<p>Ce lien expire dans 7 jours.</p>`;

  const subject = `Invitation à rejoindre ${opts.orgName}`.replace(/[\r\n]/g, "");
  await sendMail(opts.email, subject, html);
}
