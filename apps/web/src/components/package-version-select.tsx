// SPDX-License-Identifier: Apache-2.0

import { Label } from "@appstrate/ui/components/label";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { cn } from "@appstrate/ui/cn";
import { OptionSelect, type SelectOption } from "@/components/app-ui/option-select";
import { usePackageVersions } from "../hooks/use-packages";
import type { PackageType } from "@appstrate/shared-types";

/** A context-specific option shown above the published version list. */
interface VersionLeadingOption {
  value: string;
  label: string;
}

const NO_LEADING_OPTIONS: VersionLeadingOption[] = [];
const exactVersion = (version: string): SelectOption => ({ value: version, label: `v${version}` });

/**
 * Bare version picker for any package — the rendering primitive shared by the
 * agent version field (schedule editor + run launcher) and the per-skill
 * dependency rows. It owns ONLY the shared knowledge: fetch the package's
 * published versions and render the non-yanked ones as `v{version}` options
 * (`toOption` for another shape, e.g. a dependency's caret range). A `value`
 * the list does not offer (a hand-typed pin, a yanked version) stays visible as
 * its own option rather than being silently dropped.
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
  leadingOptions = NO_LEADING_OPTIONS,
  toOption = exactVersion,
  disabled,
  className,
  "aria-label": ariaLabel,
}: {
  type: PackageType;
  packageId: string;
  value: string;
  onChange: (next: string) => void;
  leadingOptions?: VersionLeadingOption[];
  /** How a published version is offered; the default is the exact version. */
  toOption?: (version: string) => SelectOption;
  disabled?: boolean;
  /** On the trigger (and its loading skeleton). */
  className?: string;
  "aria-label"?: string;
}) {
  const { data: versions, isLoading } = usePackageVersions(type, packageId);
  if (isLoading) return <Skeleton className={cn("h-9 w-full", className)} />;
  const options = [
    ...leadingOptions,
    ...(versions?.filter((v) => !v.yanked).map((v) => toOption(v.version)) ?? []),
  ];
  if (value && !options.some((option) => option.value === value)) {
    options.unshift({ value, label: value });
  }
  return (
    <OptionSelect
      value={value}
      onValueChange={onChange}
      disabled={disabled}
      options={options}
      className={className}
      aria-label={ariaLabel}
    />
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
    <div className="flex flex-col gap-2">
      <Label className="mb-0">{label}</Label>
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
