// SPDX-License-Identifier: Apache-2.0

import { lazy, Suspense, forwardRef } from "react";
import type RjsfForm from "@rjsf/core";
import type { SchemaFormProps } from "@appstrate/ui/schema-form";
import { Spinner } from "./spinner";

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
      <Suspense
        fallback={
          <div className="flex items-center justify-center py-8">
            <Spinner />
          </div>
        }
      >
        <SchemaFormInner ref={ref} {...props} />
      </Suspense>
    );
  },
);
