import { logger } from "../lib/logger.ts";

const BREVO_API_KEY = process.env.BREVO_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || "noreply@appstrate.io";
const EMAIL_FROM_NAME = process.env.EMAIL_FROM_NAME || "Appstrate";

interface SendEmailParams {
  to: string;
  subject: string;
  htmlContent: string;
}

export async function sendEmail({ to, subject, htmlContent }: SendEmailParams): Promise<boolean> {
  if (!BREVO_API_KEY) {
    logger.warn("BREVO_API_KEY not set — skipping email send", { to, subject });
    return false;
  }

  try {
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": BREVO_API_KEY,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        sender: { name: EMAIL_FROM_NAME, email: EMAIL_FROM },
        to: [{ email: to }],
        subject,
        htmlContent,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      logger.error("Brevo API error", { status: res.status, body, to, subject });
      return false;
    }

    logger.info("Email sent", { to, subject });
    return true;
  } catch (err) {
    logger.error("Email send failed", {
      error: err instanceof Error ? err.message : String(err),
      to,
      subject,
    });
    return false;
  }
}
