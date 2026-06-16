// SPDX-License-Identifier: Apache-2.0

import { Label } from "@appstrate/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@appstrate/ui/components/select";
import { usePackageVersions } from "../hooks/use-packages";
import type { PackageType } from "@appstrate/shared-types";

/** A context-specific option shown above the published version list. */
export interface VersionLeadingOption {
  value: string;
  label: string;
}

/**
 * Bare version picker for any package — the rendering primitive shared by the
 * agent version field (schedule editor + run launcher) and the per-skill
 * dependency rows. It owns ONLY the shared knowledge: fetch the package's
 * published versions and render the non-yanked ones as `v{version}` options.
 *
 * The *semantics* differ by context and stay with the caller, supplied as data
 * (never a behaviour flag): `leadingOptions` are the context-specific choices
 * shown first (e.g. the run launcher passes `default` + `draft`; the schedule
 * editor passes `inherit` + `draft`; a skill row passes `inherit` + `draft`),
 * and the caller owns `value`/`onChange` — including any default and "selecting
 * the pinned version means inherit" rules. This keeps a single source of truth
 * for the version list while letting each context define what a selection means.
 */
export function PackageVersionSelect({
  type,
  packageId,
  value,
  onChange,
  leadingOptions,
}: {
  type: PackageType;
  packageId: string;
  value: string;
  onChange: (next: string) => void;
  leadingOptions: VersionLeadingOption[];
}) {
  const { data: versions } = usePackageVersions(type, packageId);
  return (
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
  );
}

/**
 * Labeled agent version picker — the schedule editor and the run launcher both
 * want a `<Label>` above the agent's {@link PackageVersionSelect}. Thin wrapper
 * pinning `type="agent"`; semantics still flow through `leadingOptions`.
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
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <PackageVersionSelect
        type="agent"
        packageId={packageId}
        value={value}
        onChange={onChange}
        leadingOptions={leadingOptions}
      />
    </div>
  );
}
