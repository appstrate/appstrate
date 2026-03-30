import type { EmailPropsMap, RenderedEmail } from "../types.ts";
import { createSimpleEmailRenderer } from "./simple-email.ts";

const render = createSimpleEmailRenderer({
  fr: {
    subject: "Réinitialisez votre mot de passe",
    body: "Cliquez sur le lien ci-dessous pour réinitialiser votre mot de passe :",
    footer: "Si vous n'avez pas demandé cette réinitialisation, vous pouvez ignorer cet email.",
  },
  en: {
    subject: "Reset your password",
    body: "Click the link below to reset your password:",
    footer: "If you didn't request this reset, you can safely ignore this email.",
  },
});

export function renderResetPasswordEmail(props: EmailPropsMap["reset-password"]): RenderedEmail {
  return render(props);
}
