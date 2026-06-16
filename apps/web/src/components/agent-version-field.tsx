// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { usePackageVersions } from "../hooks/use-packages";

/** A context-specific option shown above the published version list. */
export interface VersionLeadingOption {
  value: string;
  label: string;
}

/**
 * Agent version picker — the rendering primitive shared by the schedule editor
 * and the run launcher. It owns ONLY the shared knowledge: fetch the agent's
 * published versions and render the non-yanked ones as `v{version}` options.
 *
 * The *semantics* differ by context and stay with the caller, supplied as data
 * (never a behaviour flag): `leadingOptions` are the context-specific choices
 * shown first (e.g. the run launcher passes `draft`; the schedule editor passes
 * `inherit` + `draft`), and the caller owns `value`/`onChange` — including any
 * default and "selecting the pinned version means inherit" rules. This keeps a
 * single source of truth for the version list while letting each context define
 * what a selection means.
 */
export function AgentVersionField({
  packageId,
  label,
  value,
  onChange,
  leadingOptions,
}: {
  packageId: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
  leadingOptions: VersionLeadingOption[];
}) {
  const { t } = useTranslation(["agents"]);
  const { data: versions } = usePackageVersions("agent", packageId);
  return (
    <div className="space-y-2">
      <Label>{label ?? t("run.overrides.versionLabel")}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {leadingOptions.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
          {versions
            ?.filter((v) => !v.yanked)
            .map((v) => (
              <SelectItem key={v.version} value={v.version}>
                v{v.version}
              </SelectItem>
            ))}
        </SelectContent>
      </Select>
    </div>
  );
}
