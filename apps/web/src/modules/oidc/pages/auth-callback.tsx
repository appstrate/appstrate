// SPDX-License-Identifier: Apache-2.0

/** OIDC callback page: exchanges the code, syncs auth state, redirects to the requested page. */

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { handleOidcCallback } from "../lib/oidc";
import { refreshAuth, AuthRefreshError } from "../../../hooks/use-auth";
import { authStore } from "../../../stores/auth-store";
import { Spinner } from "@appstrate/ui/components/spinner";
import { errorMessage } from "../../../lib/mutation-error";
import { FieldError } from "@appstrate/ui/components/field";

/** Server-rendered prefixes outside the SPA's router: they need a full navigation, or the SPA catch-all swallows them. Keep tight. */
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
        // `refreshAuth` throws if no user is established; the catch shows an
        // inline error instead of looping protected page → /login → OIDC → here.
        if (!authStore.getState().user) await refreshAuth();
        // Server-rendered pages (e.g. `/activate`) need a real navigation.
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
        setError(errorMessage(err));
      }
    })();
  }, [navigate]);

  if (error) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-8">
        <FieldError>{error}</FieldError>
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
