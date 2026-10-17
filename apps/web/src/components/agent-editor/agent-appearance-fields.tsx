// SPDX-License-Identifier: Apache-2.0

import { readAgentAppearance } from "@appstrate/core/validation";
import { agentAppearancePatch } from "../../lib/agent-appearance-patch";
import { AppearancePicker } from "../appearance-picker";

/** The agent's identity editor: its manifest `icon` and `_meta` colour, through the shared picker. */
export function AgentAppearanceFields({
  packageId,
  manifest,
  onChange,
}: {
  /** What the derived colour is drawn from. */
  packageId: string;
  manifest: Record<string, unknown>;
  onChange: (patch: Record<string, unknown>) => void;
}) {
  const label =
    typeof manifest.display_name === "string" && manifest.display_name
      ? manifest.display_name
      : packageId;
  return (
    <AppearancePicker
      value={readAgentAppearance(manifest)}
      onChange={(next) => onChange(agentAppearancePatch(manifest, next))}
      allow={["lucide"]}
      fallbackIcon="lucide:bot"
      seed={packageId}
      label={label}
    />
  );
}
