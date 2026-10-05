// SPDX-License-Identifier: Apache-2.0

import type { RenderedEmail, SupportedLocale } from "../types.ts";

interface NoticeEmailStrings {
  subject: string;
  paragraphs: string[];
}

/** Factory for the link-less account notices: a subject and plain paragraphs. */
export function createNoticeEmailRenderer(
  strings: Record<SupportedLocale, NoticeEmailStrings>,
): (data: { locale: SupportedLocale }) => RenderedEmail {
  return (data) => {
    const s = strings[data.locale] ?? strings.fr;
    return { subject: s.subject, html: s.paragraphs.map((p) => `<p>${p}</p>`).join("\n") };
  };
}
