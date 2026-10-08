// SPDX-License-Identifier: Apache-2.0

/**
 * Register page — the built-in email/password form (OSS mode).
 *
 * In OIDC mode this component never renders: `HostedAuthGate` (wired in
 * `app.tsx`) redirects to the hosted register page before it mounts.
 */

import { AuthLayout } from "../components/auth-layout";
import { RegisterForm } from "../components/register-form";

export function RegisterPage() {
  return (
    <AuthLayout>
      <RegisterForm />
    </AuthLayout>
  );
}
