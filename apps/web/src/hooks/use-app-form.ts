// SPDX-License-Identifier: Apache-2.0

import { useCallback, useRef } from "react";
import { useForm, type UseFormProps, type FieldValues, type Path } from "react-hook-form";

/**
 * Thin wrapper around react-hook-form's useForm with "reward early, punish late" validation:
 * - mode: "onTouched" — validates on first blur, re-validates onChange
 * - showError(field) — only surfaces errors for fields that were ever modified, or after submit
 *
 * Uses an "ever dirty" tracker instead of the live dirtyFields, because dirtyFields
 * flips back to false when the value returns to its default (e.g. user types then clears).
 */
export function useAppForm<T extends FieldValues>(props: Omit<UseFormProps<T>, "mode">) {
  const form = useForm<T>({ ...props, mode: "onTouched" });
  const everDirtyRef = useRef(new Set<string>());

  const showError = (field: Path<T>) => {
    const { errors, dirtyFields, isSubmitted } = form.formState;
    const dirty = dirtyFields as Record<string, boolean | undefined>;

    if (dirty[field]) {
      everDirtyRef.current.add(field);
    }

    return !!errors[field] && (everDirtyRef.current.has(field) || isSubmitted);
  };

  const originalReset = form.reset;
  const reset: typeof originalReset = useCallback(
    (...args) => {
      everDirtyRef.current.clear();
      return originalReset(...args);
    },
    [originalReset],
  );

  return { ...form, reset, showError };
}
