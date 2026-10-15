// SPDX-License-Identifier: Apache-2.0

import { useCallback, useRef } from "react";
import { useForm, type UseFormProps, type FieldValues, type Path } from "react-hook-form";

/**
 * useForm with "reward early, punish late" validation (`onTouched`): `showError(field)` surfaces
 * errors only for fields ever modified, or after submit. "Ever dirty" is tracked here because
 * `dirtyFields` flips back to false when the value returns to its default.
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
