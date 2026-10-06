// SPDX-License-Identifier: Apache-2.0

import type { EmailPropsMap, RenderedEmail } from "../types.ts";
import { createNoticeEmailRenderer } from "./notice-email.ts";

const render = createNoticeEmailRenderer({
  fr: {
    subject: "Vous avez déjà un compte",
    paragraphs: [
      "Une inscription vient d'être tentée avec cette adresse email, qui a déjà un compte. Aucun nouveau compte n'a été créé.",
      "Pour accéder à votre compte, connectez-vous comme d'habitude. Si vous avez oublié votre mot de passe, utilisez « Mot de passe oublié » sur la page de connexion.",
      "Si vous n'êtes pas à l'origine de cette inscription, ignorez cet email : votre compte n'a pas été modifié.",
    ],
  },
  en: {
    subject: "You already have an account",
    paragraphs: [
      "Someone just tried to sign up with this email address, which already has an account. No new account was created.",
      "To reach your account, sign in as usual. If you forgot your password, use “Forgot password” on the sign-in page.",
      "If this sign-up was not yours, ignore this email: your account was not changed.",
    ],
  },
});

export function renderExistingAccountEmail(
  props: EmailPropsMap["existing-account"],
): RenderedEmail {
  return render(props);
}
