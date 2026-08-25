// SPDX-License-Identifier: Apache-2.0

/**
 * The SPA's no-DOM component harness, and the typed row fixture that goes with
 * it.
 *
 * The web test runner has no jsdom: a component under test is rendered with
 * `renderToStaticMarkup` and asserted on its HTML. Five suites carried their
 * own copy of the provider stack and the same two entity unescapes; three also
 * carried a `FileDto` literal ending in `as unknown as FileDto`, which is the
 * opposite of a typed fixture — the cast made the literal survive any change to
 * the generated wire type instead of failing the build the way a real value
 * would.
 */

import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18n from "../i18n.ts";
import type { FileDto } from "../hooks/use-files.ts";

/**
 * Render `node` inside the three providers the run/agent surfaces need: a query
 * client (panels wire delete/keep mutations on mount), i18n, and a router.
 * Providers emit no markup of their own, so a component that needs only one of
 * them renders identically here.
 *
 * `renderToStaticMarkup` escapes the apostrophes and quotes the French copy is
 * full of; they are decoded back so an assertion can be written with the
 * literal bundle string instead of a hand-escaped copy that drifts from it.
 *
 * Pass `queryClient` when the test seeds the cache (`qc.setQueryData(...)`)
 * before rendering.
 */
export function render(node: ReactElement, options: { queryClient?: QueryClient } = {}): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={options.queryClient ?? new QueryClient()}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter>{node}</MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  )
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"');
}

/**
 * A complete `FileDto` row — every field the generated schema requires, with
 * defaults that describe an ordinary readable agent output.
 *
 * Typed, not cast: add a required field to `/api/files`' item schema and this
 * builder stops compiling, which is the whole point. Suites override the
 * handful of fields their case turns on.
 */
export function fileFixture(overrides: Partial<FileDto> & { name: string }): FileDto {
  return {
    object: "file",
    id: `file_${overrides.name}`,
    uri: `appfile://file_${overrides.name}`,
    purpose: "agent_output",
    applicationId: "app_1",
    run_id: null,
    chat_session_id: null,
    packageId: "@acme/reporter",
    mime: "text/plain",
    size: 12,
    downloadable: true,
    capabilities: {
      visible: true,
      metadata: true,
      download: true,
      preview: false,
      keep: false,
      delete: false,
    },
    previewable: false,
    preview_kind: null,
    expiresAt: null,
    createdAt: "2026-07-01T10:00:00.000Z",
    ...overrides,
  };
}
