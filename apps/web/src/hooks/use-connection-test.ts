import { useState } from "react";
import type { UseMutationResult } from "@tanstack/react-query";
import type { TestResult } from "@appstrate/shared-types";

export function useConnectionTest(mutation: UseMutationResult<TestResult, Error, string>) {
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, TestResult | null>>({});

  const handleTest = (id: string) => {
    setTestingId(id);
    mutation.mutate(id, {
      onSuccess: (result) => {
        setTestResults((prev) => ({ ...prev, [id]: result }));
        setTestingId(null);
        setTimeout(() => setTestResults((prev) => ({ ...prev, [id]: null })), 5000);
      },
      onError: () => {
        setTestResults((prev) => ({
          ...prev,
          [id]: { ok: false, latency: 0, error: "INTERNAL_ERROR", message: "Test failed" },
        }));
        setTestingId(null);
        setTimeout(() => setTestResults((prev) => ({ ...prev, [id]: null })), 5000);
      },
    });
  };

  return { testingId, testResults, handleTest };
}
