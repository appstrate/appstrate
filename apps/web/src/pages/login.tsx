// SPDX-License-Identifier: Apache-2.0

/** Built-in email/password login (OSS mode); in OIDC mode `HostedAuthGate` redirects before this mounts. */

import { AuthLayout } from "../components/auth-layout";
import { LoginForm } from "../components/login-form";

export function LoginPage() {
  return (
    <AuthLayout>
      <LoginForm />
    </AuthLayout>
  );
}
