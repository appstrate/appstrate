import { useState, useCallback, useRef } from "react";

type Validator = (value: string) => string | undefined;
type Rules = Record<string, Validator>;

export function useFormErrors(rules: Rules) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const dirtyFields = useRef<Set<string>>(new Set());

  const onBlur = useCallback(
    (field: string, value: string) => {
      if (!dirtyFields.current.has(field)) return;
      const validator = rules[field];
      if (!validator) return;
      const error = validator(value);
      setErrors((prev) => {
        if (error) return { ...prev, [field]: error };
        const { [field]: _, ...rest } = prev;
        return rest;
      });
    },
    [rules],
  );

  const validateAll = useCallback(
    (values: Record<string, string>): boolean => {
      const next: Record<string, string> = {};
      for (const [field, validator] of Object.entries(rules)) {
        const error = validator(values[field] ?? "");
        if (error) next[field] = error;
      }
      setErrors(next);
      return Object.keys(next).length === 0;
    },
    [rules],
  );

  const clearErrors = useCallback(() => {
    setErrors({});
    dirtyFields.current.clear();
  }, []);

  const clearField = useCallback((field: string) => {
    dirtyFields.current.add(field);
    setErrors((prev) => {
      const { [field]: _, ...rest } = prev;
      return rest;
    });
  }, []);

  return { errors, onBlur, validateAll, clearErrors, clearField };
}
