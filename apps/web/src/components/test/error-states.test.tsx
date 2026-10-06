// SPDX-License-Identifier: Apache-2.0

/**
 * What a failure looks like on screen: a refused listing is not an empty one,
 * an unreadable resource gets one sentence in the reader's language, and a
 * render crash neither shows its exception text nor outlives the navigation
 * that leaves the page.
 */

import { describe, expect, it } from "bun:test";
import { MutationObserver, QueryClient } from "@tanstack/react-query";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { RunList } = await import("../run-list.tsx");
const { ResourceErrorState } = await import("../page-states.tsx");
const { ErrorBoundary } = await import("../error-boundary.tsx");
const { createConfirmer } = await import("../../lib/confirm-settle.ts");
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

  // The integration page: what to ask for, and a way back to the listing.
  const withWayForward = (status: number) =>
    render(
      <ResourceErrorState
        error={new ApiError("not_found", "Integration not found", status)}
        hint="ask-an-admin-hint"
      >
        <a href="/integrations">back-to-listing</a>
      </ResourceErrorState>,
    );

  it("carries the page's hint and action on a 403 and on a 404 alike", () => {
    for (const status of [403, 404]) {
      const html = withWayForward(status);

      expect(html).toContain(t("error.resourceUnavailable"));
      expect(html).toContain("ask-an-admin-hint");
      expect(html).toContain("back-to-listing");
      expect(html).not.toContain(t("error.resourceUnavailableHint"));
    }
  });

  it("shows neither the hint nor the action for another failure", () => {
    const html = withWayForward(500);

    expect(html).toContain(t("error.generic"));
    expect(html).not.toContain("ask-an-admin-hint");
    expect(html).not.toContain("back-to-listing");
  });

  it("says the generic sentence once for a failure that carries no message", () => {
    const html = render(<ResourceErrorState error={new Error("")} />);

    expect(html.split(t("error.generic")).length - 1).toBe(1);
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

// `ConfirmModal` cannot be clicked without a DOM; a click there is one call of
// the function below, over the real mutation cache.
describe("ConfirmModal: one confirmation at a time, closed on a refusal", () => {
  const deferred = () => {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  /** A dialog whose confirm action runs one mutation the test settles by hand. */
  const dialog = () => {
    const queryClient = new QueryClient();
    const requests: ReturnType<typeof deferred>[] = [];
    const observer = new MutationObserver(queryClient, {
      mutationFn: () => {
        const request = deferred();
        requests.push(request);
        return request.promise;
      },
    });
    const runConfirm = createConfirmer(queryClient.getMutationCache());
    let refusals = 0;
    const click = () =>
      runConfirm(
        () => void observer.mutate().catch(() => undefined),
        () => {
          refusals += 1;
        },
      );
    return { click, requests, refusals: () => refusals };
  };

  it("sends one request for two clicks in the same tick", async () => {
    const d = dialog();
    d.click();
    d.click();
    await flush();

    expect(d.requests).toHaveLength(1);
  });

  it("reports a refusal without ever having rendered a pending state", async () => {
    const d = dialog();
    d.click();
    await flush();
    d.requests[0]!.reject(new ApiError("space_has_running_runs", "runs in progress", 409));
    await flush();

    expect(d.refusals()).toBe(1);
  });

  it("does not report a success", async () => {
    const d = dialog();
    d.click();
    await flush();
    d.requests[0]!.resolve();
    await flush();

    expect(d.refusals()).toBe(0);
  });

  it("accepts a new confirm once the previous one settled", async () => {
    const d = dialog();
    d.click();
    await flush();
    d.requests[0]!.reject(new Error("refused"));
    await flush();

    d.click();
    await flush();
    expect(d.requests).toHaveLength(2);
  });

  it("accepts the next click at once when the confirm action starts no mutation", () => {
    const runConfirm = createConfirmer(new QueryClient().getMutationCache());
    let runs = 0;
    const click = () =>
      runConfirm(
        () => {
          runs += 1;
        },
        () => {},
      );
    click();
    click();

    expect(runs).toBe(2);
  });
});
