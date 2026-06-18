// SPDX-License-Identifier: Apache-2.0

/**
 * Login page — the built-in email/password form (OSS mode).
 *
 * In OIDC mode this component never renders: `HostedAuthGate` (wired in
 * `app.tsx`) redirects to the hosted login page before it mounts. The page is
 * therefore a pure OSS fallback with no auth logic of its own.
 */

import { AuthLayout } from "../components/auth-layout";
import { LoginForm } from "../components/login-form";

export function LoginPage() {
  return (
    <AuthLayout>
      <LoginForm />
    </AuthLayout>
  );
}
