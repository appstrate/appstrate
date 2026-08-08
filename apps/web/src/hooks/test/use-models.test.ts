// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { invalidateModelConnectionTestQueries } from "../use-models.ts";

const MODELS_KEY = ["get", "/api/models", { params: { header: { "X-Org-Id": "org_1" } } }];
const CREDENTIALS_KEY = [
  "get",
  "/api/model-provider-credentials",
  { params: { header: { "X-Org-Id": "org_1" } } },
];
const PROXIES_KEY = ["get", "/api/proxies", { params: { header: { "X-Org-Id": "org_1" } } }];

const isInvalidated = (qc: QueryClient, key: readonly unknown[]) =>
  qc.getQueryState(key)?.isInvalidated;

describe("saved model connection test cache invalidation", () => {
  it("refreshes the model and credential lists without touching unrelated settings", async () => {
    const qc = new QueryClient();
    qc.setQueryData(MODELS_KEY, []);
    qc.setQueryData(CREDENTIALS_KEY, []);
    qc.setQueryData(PROXIES_KEY, []);

    await invalidateModelConnectionTestQueries(qc);

    expect(isInvalidated(qc, MODELS_KEY)).toBe(true);
    expect(isInvalidated(qc, CREDENTIALS_KEY)).toBe(true);
    expect(isInvalidated(qc, PROXIES_KEY)).toBe(false);
  });
});
