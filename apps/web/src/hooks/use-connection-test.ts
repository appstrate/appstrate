// SPDX-License-Identifier: Apache-2.0

import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { getErrorMessage } from "@appstrate/core/errors";
import type { components } from "../api/client";

export type TestResult = components["schemas"]["TestResult"];

/**
 * Structural subset of the typed `$api.useMutation` result for the
 * `POST .../{id}/test` endpoints (models, proxies, credentials) — variables
 * follow the openapi-react-query `{ params: { path: { id } } }` shape.
 */
interface TestMutation {
  mutateAsync: (variables: { params: { path: { id: string } } }) => Promise<TestResult>;
}

export function useConnectionTest(mutation: TestMutation) {
  const { t } = useTranslation("common");
  const [testingIds, setTestingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [testResults, setTestResults] = useState<Record<string, TestResult | null>>({});
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
    };
  }, []);

  const scheduleClear = (id: string) => {
    const existing = timersRef.current.get(id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      setTestResults((prev) => ({ ...prev, [id]: null }));
      timersRef.current.delete(id);
    }, 5000);
    timersRef.current.set(id, timer);
  };

  const handleTest = async (id: string) => {
    setTestingIds((prev) => new Set(prev).add(id));
    try {
      // `mutateAsync` gives every concurrent call its own promise lifecycle.
      // Per-call callbacks passed to `mutate` only remain attached to the most
      // recent observer, which can strand an earlier row in its pending state.
      const result = await mutation.mutateAsync({ params: { path: { id } } });
      if (!result.ok) toast.error(result.message || t("test.failed"));
      setTestResults((prev) => ({ ...prev, [id]: result }));
    } catch (error) {
      toast.error(getErrorMessage(error));
      setTestResults((prev) => ({
        ...prev,
        [id]: { ok: false, latency: 0, error: "INTERNAL_ERROR", message: t("test.failed") },
      }));
    } finally {
      setTestingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      scheduleClear(id);
    }
  };

  return { testingIds, testResults, handleTest };
}
