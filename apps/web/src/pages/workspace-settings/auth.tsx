// SPDX-License-Identifier: Apache-2.0

import { lazy, Suspense } from "react";
import { useCurrentSpaceId } from "../../hooks/use-current-space";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { SettingsSkeleton } from "../../components/loading-skeletons";
import { UnavailableState } from "../../components/route-gate";

const SpaceAuthTab = lazy(() =>
  import("../../modules/oidc/components/space-auth-tab").then((m) => ({
    default: m.SpaceAuthTab,
  })),
);

export function WorkspaceSettingsAuthPage() {
  const spaceId = useCurrentSpaceId();

  if (!spaceId) return <UnavailableState />;

  return (
    <Suspense fallback={<SpaceAuthSkeleton />}>
      <SpaceAuthTab />
    </Suspense>
  );
}

/**
 * `SpaceAuthTab` while its code loads: its three sections (SMTP, Google, GitHub) in their
 * `max-w-2xl` column, each a heading and hint over its rows — the shape each section then waits
 * in on its own read.
 */
function SpaceAuthSkeleton() {
  return (
    <div className="flex max-w-2xl flex-col gap-10">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1" aria-hidden>
            <div className="flex h-7 items-center">
              <Skeleton className="h-5 w-48" />
            </div>
            <div className="flex h-5 items-center">
              <Skeleton className="h-3.5 w-80 max-w-full" />
            </div>
          </div>
          <SettingsSkeleton />
        </div>
      ))}
    </div>
  );
}
