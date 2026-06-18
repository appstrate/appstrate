// SPDX-License-Identifier: Apache-2.0

import { useLocation } from "react-router-dom";
import { useHostedAuthRedirect } from "../hooks/use-hosted-auth-redirect";
import { Spinner } from "./spinner";

/**
 * Render gate for the unauthenticated auth-entry routes.
 *
 * In OIDC mode it redirects to the hosted login / register page (via the
 * shared `useHostedAuthRedirect` seam) and shows a spinner while the browser
 * navigates away — the wrapped native form never renders. In OSS mode it is a
 * pass-through and renders the form.
 *
 * Wrapping the routes here (rather than per-page `useEffect` checks copied into
 * every auth page) is the structural guarantee that a new auth route cannot
 * forget the OIDC redirect: it inherits the gate from `app.tsx`, and the
 * ESLint `auth-client` ban stops it from calling Better Auth directly.
 *
 * For `starter="login"`, the post-callback destination is read from
 * `location.state.from` — the same hand-off the server-side
 * `/auth/login?returnTo=…` bridge populates — so a deep link survives the
 * round-trip. Other starters have no `from`, which is a harmless `undefined`.
 */
export function HostedAuthGate({
  starter = "login",
  children,
}: {
  starter?: "login" | "signup";
  children: React.ReactNode;
}) {
  const location = useLocation();
  const from = starter === "login" ? (location.state as { from?: string } | null)?.from : undefined;

  const { redirecting } = useHostedAuthRedirect({ starter, redirectTo: from });

  if (redirecting) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner />
      </div>
    );
  }

  return <>{children}</>;
}
