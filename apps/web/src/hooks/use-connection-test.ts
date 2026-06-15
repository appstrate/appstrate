// SPDX-License-Identifier: Apache-2.0

import { useState, useRef, useEffect } from "react";
import type { components } from "../api/client";

type TestResult = components["schemas"]["TestResult"];

/**
 * Structural subset of the typed `$api.useMutation` result for the
 * `POST .../{id}/test` endpoints (models, proxies, credentials) — variables
 * follow the openapi-react-query `{ params: { path: { id } } }` shape.
 */
interface TestMutation {
  mutate: (
    variables: { params: { path: { id: string } } },
    options: {
      onSuccess: (result: TestResult) => void;
      onError: () => void;
    },
  ) => void;
}

export function useConnectionTest(mutation: TestMutation) {
  const [testingId, setTestingId] = useState<string | null>(null);
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

  const handleTest = (id: string) => {
    setTestingId(id);
    mutation.mutate(
      { params: { path: { id } } },
      {
        onSuccess: (result) => {
          setTestResults((prev) => ({ ...prev, [id]: result }));
          setTestingId(null);
          scheduleClear(id);
        },
        onError: () => {
          setTestResults((prev) => ({
            ...prev,
            [id]: { ok: false, latency: 0, error: "INTERNAL_ERROR", message: "Test failed" },
          }));
          setTestingId(null);
          scheduleClear(id);
        },
      },
    );
  };

  return { testingId, testResults, handleTest };
}
