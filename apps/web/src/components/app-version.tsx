// SPDX-License-Identifier: Apache-2.0

import { useAppConfig } from "../hooks/use-app-config";

/**
 * Discreet display of the deployed build identity (version + git SHA), read
 * from the injected app config — no API call. Renders nothing when the build
 * identity is absent (source runs without a stamped version).
 */
export function AppVersion({ className }: { className?: string }) {
  const { version } = useAppConfig();

  if (!version) return null;

  const label = version.commit ? `${version.app} · ${version.commit}` : version.app;

  return (
    <span
      className={`text-muted-foreground font-mono text-xs ${className ?? ""}`}
      title={version.commit ? `${version.app} (${version.commit})` : version.app}
    >
      {label}
    </span>
  );
}
