// SPDX-License-Identifier: Apache-2.0

/**
 * OIDC callback page — receives the authorization code after login.
 *
 * Exchanges the code, syncs auth state from the now-active Better Auth
 * session, and redirects to the originally requested page.
 */

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { handleOidcCallback } from "../lib/oidc";
import { refreshAuth, AuthRefreshError } from "../../../hooks/use-auth";
import { Spinner } from "../../../components/spinner";

/**
 * Server-rendered prefixes that live outside the SPA's router. Paths
 * starting with these need a full browser navigation rather than a
 * React Router client-side transition — otherwise the SPA matches its
 * own catch-all and the SSR page never renders.
 *
 * Keep this list tight — over-eager matching would force a full
 * reload on every navigation and ruin dashboard UX.
 */
const SERVER_RENDERED_PREFIXES = ["/activate", "/api/oauth/"];

function isServerRenderedPath(path: string): boolean {
  if (!path.startsWith("/")) return false;
  return SERVER_RENDERED_PREFIXES.some((p) => path === p || path.startsWith(p));
}

export function AuthCallbackPage() {
  const navigate = useNavigate();
  const handled = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (handled.current) return;
    handled.current = true;

    (async () => {
      try {
        const { redirectTo } = await handleOidcCallback();
        // Sync auth state — the BA session cookie is now active.
        // `refreshAuth` throws `AuthRefreshError` if the resync did not
        // establish a user (stale cookie, server-side session gone). The
        // catch below turns that into an inline error rather than letting
        // us navigate onto a protected page → catch-all → /login → OIDC
        // re-redirect → back here in a tight loop with no error UI.
        await refreshAuth();
        // Server-rendered pages outside the SPA (e.g. `/activate` for
        // the CLI device-flow consent) need a real browser navigation
        // — React Router's `navigate()` would push history but the SPA
        // would match its own catch-all and render the dashboard
        // shell instead of letting the server produce the page.
        // `window.location.assign` triggers a full request so the
        // browser ends up on the correct SSR output.
        if (isServerRenderedPath(redirectTo)) {
          window.location.assign(redirectTo);
          return;
        }
        navigate(redirectTo, { replace: true });
      } catch (err) {
        if (err instanceof AuthRefreshError && err.code === "no_session") {
          setError(
            "Authentication did not complete — the session could not be established. Please sign in again.",
          );
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
      }
    })();
  }, [navigate]);

  if (error) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-8">
        <p className="text-destructive text-sm">{error}</p>
        <a href="/login" className="text-primary text-sm underline">
          Retour à la connexion
        </a>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center">
      <Spinner />
    </div>
  );
}
