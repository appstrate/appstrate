// SPDX-License-Identifier: Apache-2.0

/**
 * The email + password fields shared by the sign-in and sign-up forms.
 *
 * The two forms carried ~55 lines of identical field markup each, and that
 * copy is what let the password minimum drift: both restated it, both said 6,
 * while the server (`minPasswordLength` in `packages/db/src/auth.ts`) enforced
 * 8 — so the form told the user 6 was enough, accepted it, and Better Auth
 * refused the signup. The rule now lives in one place on the server and is
 * imported here; the markup lives in one place too, so the next edit lands on
 * both surfaces at once.
 *
 * `register` / `invalid` / `error` are passed in rather than pulled from a form
 * context: the two forms are typed on different shapes (`LoginFormData` /
 * `RegisterFormData`) and `useAppForm` exposes `showError`, which no RHF
 * context carries.
 */

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { FieldValues, Path, UseFormRegister } from "react-hook-form";
import { cn } from "@appstrate/ui/cn";
import { Input } from "@appstrate/ui/components/input";
import { Label } from "@appstrate/ui/components/label";
import { MIN_PASSWORD_LENGTH } from "@appstrate/shared-types";

/** Deliberately permissive — the server is the authority on deliverability. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface SharedFieldProps<T extends FieldValues> {
  register: UseFormRegister<T>;
  name: Path<T>;
  /** Already-translated label — the caller owns its i18n namespace. */
  label: string;
  /** `showError(name)` from `useAppForm`: the error exists AND is surfaceable. */
  invalid: boolean;
  error?: string;
}

interface EmailFieldProps<T extends FieldValues> extends SharedFieldProps<T> {
  /**
   * When set, the address is imposed (invitation, closed-mode bootstrap): the
   * input is read-only and is NOT registered, so the caller sends this value.
   */
  fixedValue?: string;
}

export function EmailField<T extends FieldValues>({
  register,
  name,
  label,
  invalid,
  error,
  fixedValue,
}: EmailFieldProps<T>) {
  const { t } = useTranslation("common");
  return (
    <div className="grid gap-2">
      <Label htmlFor="email">{label}</Label>
      <Input
        id="email"
        type="email"
        placeholder="email@example.com"
        autoComplete="email"
        readOnly={!!fixedValue}
        aria-invalid={invalid ? true : undefined}
        className={cn(
          invalid && "border-destructive",
          fixedValue && "cursor-not-allowed opacity-60",
        )}
        {...(fixedValue
          ? { value: fixedValue }
          : register(name, {
              required: t("validation.required"),
              pattern: { value: EMAIL_PATTERN, message: t("validation.emailFormat") },
            }))}
      />
      {invalid && <div className="text-destructive text-sm">{error}</div>}
    </div>
  );
}

interface PasswordFieldProps<T extends FieldValues> extends SharedFieldProps<T> {
  /**
   * `"current-password"` on sign-in, `"new-password"` on sign-up. It also
   * decides whether the browser's own `minlength` constraint is attached: on a
   * NEW password that matches the server-rendered OIDC signup page, which has
   * always refused a short password in the browser. On sign-in it must not be
   * attached — the minimum describes what may be created, and a client-side
   * constraint there would lock out an account whose password predates it.
   */
  autoComplete: "current-password" | "new-password";
  /** Rendered on the label row, e.g. the "forgot password?" link. */
  labelAction?: ReactNode;
}

export function PasswordField<T extends FieldValues>({
  register,
  name,
  label,
  invalid,
  error,
  autoComplete,
  labelAction,
}: PasswordFieldProps<T>) {
  const { t } = useTranslation("common");
  const isNewPassword = autoComplete === "new-password";
  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between">
        <Label htmlFor="password">{label}</Label>
        {labelAction}
      </div>
      <Input
        id="password"
        type="password"
        placeholder="••••••••"
        autoComplete={autoComplete}
        minLength={isNewPassword ? MIN_PASSWORD_LENGTH : undefined}
        aria-invalid={invalid ? true : undefined}
        className={cn(invalid && "border-destructive")}
        {...register(name, {
          required: t("validation.required"),
          // Only on sign-UP. The minimum describes what may be CREATED, not
          // what may be presented: an account whose password predates the
          // rule must still be able to sign in, and the server is the only
          // thing entitled to reject its credential. Enforcing it here would
          // lock such a user out of the SPA with a message the API never sent.
          ...(isNewPassword
            ? {
                minLength: {
                  value: MIN_PASSWORD_LENGTH,
                  message: t("validation.minLength", { min: MIN_PASSWORD_LENGTH }),
                },
              }
            : {}),
        })}
      />
      {invalid && <div className="text-destructive text-sm">{error}</div>}
    </div>
  );
}
