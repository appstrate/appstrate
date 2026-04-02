// SPDX-License-Identifier: Apache-2.0

import type { EmailPropsMap, RenderedEmail } from "../types.ts";
import { createSimpleEmailRenderer } from "./simple-email.ts";

const render = createSimpleEmailRenderer({
  fr: {
    subject: "Vérifiez votre adresse email",
    body: "Cliquez sur le lien ci-dessous pour vérifier votre adresse email :",
    footer: "Si vous n'avez pas créé de compte, ignorez cet email.",
  },
  en: {
    subject: "Verify your email address",
    body: "Click the link below to verify your email address:",
    footer: "If you did not create an account, ignore this email.",
  },
});

export function renderVerificationEmail(props: EmailPropsMap["verification"]): RenderedEmail {
  return render(props);
}
