// SPDX-License-Identifier: Apache-2.0

/**
 * Register page — redirects to the OIDC signup flow when configured, falls
 * back to the built-in RegisterForm when the OIDC module is not loaded.
 */

import { useEffect } from "react";
import { AuthLayout } from "../components/auth-layout";
import { RegisterForm } from "../components/register-form";
import { Spinner } from "../components/spinner";

export function RegisterPage() {
  const oidcConfig = (window.__APP_CONFIG__ as unknown as Record<string, unknown>)?.oidc;

  useEffect(() => {
    if (oidcConfig) {
      import("../modules/oidc/lib/oidc").then(({ startOidcSignup }) => {
        startOidcSignup();
      });
    }
  }, [oidcConfig]);

  if (oidcConfig) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner />
      </div>
    );
  }

  return (
    <AuthLayout>
      <RegisterForm />
    </AuthLayout>
  );
}
