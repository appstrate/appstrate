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
import { refreshAuth } from "../../../hooks/use-auth";
import { Spinner } from "../../../components/spinner";

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
        // Sync auth state — the BA session cookie is now active
        await refreshAuth();
        navigate(redirectTo, { replace: true });
      } catch (err) {
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
