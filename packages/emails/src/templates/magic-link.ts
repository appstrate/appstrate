import type { EmailPropsMap, RenderedEmail } from "../types.ts";
import { createSimpleEmailRenderer } from "./simple-email.ts";

const render = createSimpleEmailRenderer({
  fr: {
    subject: "Votre lien de connexion",
    body: "Cliquez sur le lien ci-dessous pour vous connecter :",
    footer: "Si vous n'avez pas demandé ce lien, vous pouvez ignorer cet email.",
  },
  en: {
    subject: "Your sign-in link",
    body: "Click the link below to sign in:",
    footer: "If you didn't request this link, you can safely ignore this email.",
  },
});

export function renderMagicLinkEmail(props: EmailPropsMap["magic-link"]): RenderedEmail {
  return render(props);
}
