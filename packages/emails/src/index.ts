// SPDX-License-Identifier: Apache-2.0

export { renderEmail, registerEmailOverrides, resetEmailRegistry } from "./registry.ts";
export { linkValiditySentence } from "./templates/simple-email.ts";
export type {
  EmailType,
  EmailPropsMap,
  EmailRenderer,
  RenderedEmail,
  SupportedLocale,
} from "./types.ts";
