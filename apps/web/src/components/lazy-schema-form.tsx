// SPDX-License-Identifier: Apache-2.0

import { lazy, Suspense, forwardRef } from "react";
import type RjsfForm from "@rjsf/core";
import type { SchemaFormProps } from "@appstrate/ui/schema-form";
import { SettingsSkeleton } from "./loading-skeletons";

/**
 * Lazy boundary around `@appstrate/ui/schema-form` so the RJSF + AJV stack
 * (~100 KB gzip) is fetched only when a JSON-Schema form actually renders
 * (run modal, schedule form, overrides panel, configuration tab) instead of
 * shipping in the entry chunk.
 *
 * Drop-in replacement: same props and the same `RjsfForm` ref contract as
 * the underlying `SchemaForm`.
 */
const SchemaFormInner = lazy(() =>
  import("@appstrate/ui/schema-form").then((m) => ({ default: m.SchemaForm })),
);

export const LazySchemaForm = forwardRef<RjsfForm, SchemaFormProps>(
  function LazySchemaForm(props, ref) {
    return (
      <Suspense fallback={<SettingsSkeleton rows={2} />}>
        <SchemaFormInner ref={ref} {...props} />
      </Suspense>
    );
  },
);
