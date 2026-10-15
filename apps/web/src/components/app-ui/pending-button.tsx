// SPDX-License-Identifier: Apache-2.0

import type { ComponentProps } from "react";
import { Button } from "@appstrate/ui/components/button";
import { Spinner } from "@appstrate/ui/components/spinner";

/**
 * A shadcn `Button` whose action is in flight: disabled, busy, and a spinner
 * drawn before its label, which stays so the button keeps its width.
 */
export function PendingButton({
  pending = false,
  disabled,
  children,
  ...props
}: ComponentProps<typeof Button> & { pending?: boolean }) {
  return (
    <Button {...props} disabled={disabled || pending} aria-busy={pending || undefined}>
      {pending && <Spinner aria-hidden />}
      {children}
    </Button>
  );
}
