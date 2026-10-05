// SPDX-License-Identifier: Apache-2.0

import { createAuthClient } from "better-auth/react";
import { magicLinkClient } from "better-auth/client/plugins";
import { followsAuthRedirect } from "./auth-flow";

export const authClient = createAuthClient({
  baseURL: window.location.origin,
  plugins: [magicLinkClient()],
  // Better Auth's one default fetch plugin navigates on every
  // `{ redirect: true, url }` answer. `followsAuthRedirect` is that rule minus
  // the email sign-in, which this SPA routes itself.
  disableDefaultFetchPlugins: true,
  fetchOptions: {
    onSuccess(context) {
      const data: unknown = context.data;
      const path = new URL(context.response.url).pathname;
      if (followsAuthRedirect(path, data as { redirect?: unknown; url?: unknown } | null)) {
        window.location.href = (data as { url: string }).url;
      }
    },
  },
});
