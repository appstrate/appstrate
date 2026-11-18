// SPDX-License-Identifier: Apache-2.0

import { parseFileUri } from "@appstrate/core/file-uri";

/**
 * react-markdown drops a URL whose protocol it does not know, and `appfile:` is the platform's:
 * a well-formed file URI passes, everything else keeps the library's own rule (relative, http,
 * https, irc, ircs, mailto, xmpp).
 */
export function urlTransform(url: string): string {
  if (parseFileUri(url)) return url;
  const colon = url.indexOf(":");
  const slash = url.indexOf("/");
  const question = url.indexOf("?");
  const hash = url.indexOf("#");
  if (
    colon === -1 ||
    (slash !== -1 && colon > slash) ||
    (question !== -1 && colon > question) ||
    (hash !== -1 && colon > hash) ||
    /^(https?|ircs?|mailto|xmpp)$/i.test(url.slice(0, colon))
  ) {
    return url;
  }
  return "";
}
