// SPDX-License-Identifier: Apache-2.0

import { AuthLayout } from "../components/auth-layout";
import { LoginForm } from "../components/login-form";

export function LoginPage() {
  return (
    <AuthLayout>
      <LoginForm />
    </AuthLayout>
  );
}
