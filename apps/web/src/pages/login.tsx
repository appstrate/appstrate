// SPDX-License-Identifier: Apache-2.0

/**
 * Login page — redirects to the OIDC authorize flow when configured,
 * falls back to the built-in LoginForm when OIDC is not available.
 */

import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { AuthLayout } from "../components/auth-layout";
import { LoginForm } from "../components/login-form";
import { Spinner } from "../components/spinner";

export function LoginPage() {
  const location = useLocation();
  const oidcConfig = (window.__APP_CONFIG__ as unknown as Record<string, unknown>)?.oidc;

  useEffect(() => {
    if (oidcConfig) {
      // Redirect to OIDC authorize — the server-rendered login page handles auth
      const redirectTo = location.state?.from ?? "/";
      import("../modules/oidc/lib/oidc").then(({ startOidcLogin }) => {
        startOidcLogin(redirectTo);
      });
    }
  }, [oidcConfig, location.state?.from]);

  // OIDC configured: show spinner while redirect happens
  if (oidcConfig) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner />
      </div>
    );
  }

  // Fallback: OIDC not configured (module not loaded) — use built-in form
  return (
    <AuthLayout>
      <LoginForm />
    </AuthLayout>
  );
}
