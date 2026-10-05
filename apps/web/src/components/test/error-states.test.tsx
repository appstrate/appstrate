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
const { settledWhileOpen } = await import("../../lib/confirm-settle.ts");
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

// The harness has no DOM renderer and `renderToStaticMarkup` cannot run an
// error boundary, so the class is driven through the lifecycle React would
// call, with a `setState` that applies the update like React does.
describe("ErrorBoundary", () => {
  type BoundaryProps = ConstructorParameters<typeof ErrorBoundary>[0];
  const page = <p>routed-content</p>;

  const mount = (resetKey: string) => {
    const boundary = new ErrorBoundary({ children: page, resetKey });
    boundary.setState = (next) => {
      boundary.state = { ...boundary.state, ...(next as typeof boundary.state) };
    };
    return boundary;
  };
  /** One commit: optionally catch a crash, move to `resetKey`, run the update hook. */
  const commit = (
    boundary: InstanceType<typeof ErrorBoundary>,
    resetKey: string,
    crash = false,
  ) => {
    const prevProps: BoundaryProps = boundary.props;
    const prevState = boundary.state;
    if (crash) {
      boundary.state = ErrorBoundary.getDerivedStateFromError(
        new TypeError("o?.map is not a function"),
      );
    }
    (boundary as { props: BoundaryProps }).props = { children: page, resetKey };
    boundary.componentDidUpdate(prevProps, prevState);
    return render(<>{boundary.render()}</>);
  };

  it("replaces a crashed page with a retry panel that hides the exception text", () => {
    const html = commit(mount("/agents"), "/agents", true);

    expect(html).toContain(t("error.unexpected"));
    expect(html).not.toContain("o?.map is not a function");
    expect(html).not.toContain("routed-content");
  });

  it("keeps the panel while the route stays, and shows the page again once it changes", () => {
    const boundary = mount("/agents");
    commit(boundary, "/agents", true);

    expect(commit(boundary, "/agents")).toContain(t("error.unexpected"));
    expect(commit(boundary, "/runs")).toBe("<p>routed-content</p>");
  });

  it("does not clear a crash caught in the very commit that changed the route", () => {
    const html = commit(mount("/agents"), "/runs", true);

    expect(html).toContain(t("error.unexpected"));
  });
});

// The effect that applies this cannot run without a DOM; the rule it applies is
// the whole decision, and `ConfirmModal` only feeds it its refs and props.
describe("ConfirmModal: a refused confirmation closes its dialog", () => {
  const settled = { confirmed: true, wasPending: true, isPending: false, open: true };

  it("closes when the confirmed action settles on a dialog still open", () => {
    expect(settledWhileOpen(settled)).toBe(true);
  });

  it("leaves the dialog alone in every other state", () => {
    // Still running.
    expect(settledWhileOpen({ ...settled, isPending: true })).toBe(false);
    // Already closed by the caller's onSuccess.
    expect(settledWhileOpen({ ...settled, open: false })).toBe(false);
    // An unrelated mutation behind the same `isPending` settled: nobody confirmed here.
    expect(settledWhileOpen({ ...settled, confirmed: false })).toBe(false);
    // Nothing was pending.
    expect(settledWhileOpen({ ...settled, wasPending: false })).toBe(false);
  });
});
