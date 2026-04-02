// SPDX-License-Identifier: Apache-2.0

import { AuthLayout } from "../components/auth-layout";
import { RegisterForm } from "../components/register-form";

export function RegisterPage() {
  return (
    <AuthLayout>
      <RegisterForm />
    </AuthLayout>
  );
}
