// SPDX-License-Identifier: Apache-2.0

/**
 * What a failure looks like on screen: a refused listing is not an empty one,
 * an unreadable resource gets one sentence in the reader's language, and a
 * render crash neither shows its exception text nor outlives the navigation
 * that leaves the page.
 */

import { describe, expect, it } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { RunList } = await import("../run-list.tsx");
const { ResourceErrorState } = await import("../page-states.tsx");
const { ErrorBoundary } = await import("../error-boundary.tsx");
const { ApiError } = await import("../../api/errors.ts");
const { paginatedRunsKeys } = await import("../../lib/query-keys.ts");
const { render } = await import("../../test/render.tsx");
const i18nModule = await import("../../i18n.ts");

await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");
const t = i18nModule.default.t.bind(i18nModule.default);

describe("RunList", () => {
  it("shows a refused listing as an error, not as « Aucun run »", () => {
    const queryClient = new QueryClient();
    queryClient
      .getQueryCache()
      .build(queryClient, {
        queryKey: paginatedRunsKeys.list(
          null,
          null,
          "/runs",
          undefined,
          undefined,
          undefined,
          20,
          0,
        ),
      })
      .setState({
        status: "error",
        fetchStatus: "idle",
        error: new ApiError("forbidden", "Insufficient permissions: runs:read required", 403),
      });

    const html = render(<RunList />, { queryClient });

    expect(html).toContain(t("error.generic"));
    expect(html).not.toContain(t("detail.emptyRuns", { ns: "agents" }));
  });
});

describe("ResourceErrorState", () => {
  it("says a 404 or a 403 in one translated sentence, without the server's detail", () => {
    for (const status of [403, 404]) {
      const html = render(
        <ResourceErrorState error={new ApiError("not_found", "Run not found", status)} />,
      );

      expect(html).toContain(t("error.resourceUnavailable"));
      expect(html).not.toContain("Run not found");
    }
  });

  it("keeps the generic error and its message for any other failure", () => {
    const html = render(<ResourceErrorState error={new ApiError("internal", "boom", 500)} />);

    expect(html).toContain(t("error.generic"));
    expect(html).toContain("boom");
    expect(html).not.toContain(t("error.resourceUnavailable"));
  });
});

describe("ErrorBoundary", () => {
  const crashed = (resetKey: string) => {
    const boundary = new ErrorBoundary({ children: null, resetKey });
    boundary.state = ErrorBoundary.getDerivedStateFromError(
      new TypeError("o?.map is not a function"),
    );
    return boundary;
  };

  it("does not show the exception text", () => {
    const html = render(<>{crashed("/agents").render()}</>);

    expect(html).toContain(t("error.unexpected"));
    expect(html).not.toContain("o?.map is not a function");
  });

  it("clears the error when the route changes, and only then", () => {
    const boundary = crashed("/runs");
    const updates: unknown[] = [];
    boundary.setState = (next) => updates.push(next);

    boundary.componentDidUpdate({ children: null, resetKey: "/runs" });
    expect(updates).toEqual([]);

    boundary.componentDidUpdate({ children: null, resetKey: "/agents" });
    expect(updates).toEqual([{ hasError: false, reloading: false }]);
  });
});
