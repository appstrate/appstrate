// SPDX-License-Identifier: Apache-2.0

import type { UserMemoryType } from "@appstrate/core/user-memory";

/** The origin picker's value for "about me": a client-only sentinel, never sent. */
export const ABOUT_ME = "me";

/** `POST /api/me/memories` body from the add form: `ABOUT_ME` is no origin, a blank subject none. */
export function createMemoryBody(input: {
  type: UserMemoryType;
  content: string;
  subject: string;
  origin: string;
}) {
  return {
    type: input.type,
    content: input.content.trim(),
    subject: input.subject.trim() || null,
    orgId: input.origin === ABOUT_ME ? null : input.origin,
  };
}
