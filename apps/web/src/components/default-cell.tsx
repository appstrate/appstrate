// SPDX-License-Identifier: Apache-2.0

import { Badge } from "@appstrate/ui/components/badge";
import { Button } from "@appstrate/ui/components/button";

/**
 * The "default" toggle shared by every system+DB table where exactly one row is
 * the organization/app default (models, proxies, integration OAuth clients):
 * a green `Default` badge when this row is the default, otherwise a `Set as
 * default` button (when the caller permits it). One component so the badge
 * variant + button affordance never drift across surfaces.
 *
 * `canSetDefault` lets a surface hide the button on rows that can never become
 * default (e.g. an integration auth with a single eligible client). When the
 * row is neither the default nor settable, nothing renders. `disabled` is the
 * other half of that choice — the row *is* of a kind that can be the default
 * but this one currently cannot. The reason belongs elsewhere in the row: the
 * button carries `disabled:pointer-events-none`, so it is not a hover target
 * and a `title` on it would never surface.
 */
export function DefaultCell({
  isDefault,
  defaultLabel,
  setLabel,
  onSetDefault,
  canSetDefault = true,
  disabled = false,
  testId,
}: {
  isDefault: boolean;
  defaultLabel: string;
  setLabel: string;
  onSetDefault: () => void;
  canSetDefault?: boolean;
  disabled?: boolean;
  testId?: string;
}) {
  if (isDefault) {
    return <Badge variant="success">{defaultLabel}</Badge>;
  }
  if (!canSetDefault) return null;
  return (
    <Button
      size="sm"
      variant="ghost"
      className="h-7 text-xs"
      disabled={disabled}
      onClick={onSetDefault}
      data-testid={testId}
    >
      {setLabel}
    </Button>
  );
}
