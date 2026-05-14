// SPDX-License-Identifier: Apache-2.0

import { Fragment, type ReactNode } from "react";
import { SelectGroup, SelectLabel } from "@/components/ui/select";

/**
 * Render the shared "Featured / Other" split used by the credential and
 * model form pickers. Both modals filter the registry into a list of
 * pickable entries, then surface the module-declared `featured` flag as
 * a visual group above the fold. The flag is metadata only — every
 * entry remains selectable from either group.
 */
export function ProviderPickerGroups<T extends { featured: boolean }>({
  items,
  featuredLabel,
  otherLabel,
  renderItem,
}: {
  items: readonly T[];
  featuredLabel: string;
  otherLabel: string;
  renderItem: (item: T) => ReactNode;
}): ReactNode {
  const featured = items.filter((o) => o.featured);
  const other = items.filter((o) => !o.featured);
  return (
    <Fragment>
      {featured.length > 0 && (
        <SelectGroup>
          <SelectLabel>{featuredLabel}</SelectLabel>
          {featured.map(renderItem)}
        </SelectGroup>
      )}
      {other.length > 0 && (
        <SelectGroup>
          <SelectLabel>{otherLabel}</SelectLabel>
          {other.map(renderItem)}
        </SelectGroup>
      )}
    </Fragment>
  );
}
