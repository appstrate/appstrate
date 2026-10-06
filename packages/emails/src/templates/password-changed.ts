// SPDX-License-Identifier: Apache-2.0

import type { EmailPropsMap, RenderedEmail } from "../types.ts";
import { createNoticeEmailRenderer } from "./notice-email.ts";

const render = createNoticeEmailRenderer({
  fr: {
    subject: "Votre mot de passe a été modifié",
    paragraphs: [
      "Le mot de passe de votre compte vient d'être modifié.",
      "Si vous n'êtes pas à l'origine de ce changement, réinitialisez-le immédiatement avec « Mot de passe oublié » sur la page de connexion.",
      "Si c'est bien vous, vous n'avez rien à faire.",
    ],
  },
  en: {
    subject: "Your password was changed",
    paragraphs: [
      "The password of your account was just changed.",
      "If this was not you, reset it right away with “Forgot password” on the sign-in page.",
      "If this was you, there is nothing to do.",
    ],
  },
});

export function renderPasswordChangedEmail(
  props: EmailPropsMap["password-changed"],
): RenderedEmail {
  return render(props);
}
