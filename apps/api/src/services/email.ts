import { logger } from "../lib/logger.ts";
import { getEnv } from "@appstrate/env";

const { BREVO_API_KEY, EMAIL_FROM, EMAIL_FROM_NAME } = getEnv();

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

    const body = await res.text();

    if (!res.ok) {
      logger.error("Brevo API error", { status: res.status, body, to, subject });
      return false;
    }

    logger.info("Email sent", { to, subject, status: res.status, response: body });
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
