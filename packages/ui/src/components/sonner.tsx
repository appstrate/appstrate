// SPDX-License-Identifier: Apache-2.0

import { Toaster as Sonner, type ToasterProps } from "sonner";

/**
 * Sonner toaster styled for the Appstrate theme. Store-agnostic: the host app
 * passes the resolved `theme` (and may override any other `ToasterProps`).
 * Defaults to Sonner's `"system"` so it renders sensibly without a consumer.
 */
function Toaster({ theme = "system", ...props }: ToasterProps) {
  return (
    <Sonner
      theme={theme}
      className="toaster group"
      position="bottom-right"
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg",
          description: "group-[.toast]:text-muted-foreground",
          actionButton: "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton: "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
        },
      }}
      {...props}
    />
  );
}

export { Toaster };
