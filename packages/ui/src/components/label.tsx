// SPDX-License-Identifier: Apache-2.0

import * as React from "react";
import { cva } from "class-variance-authority";

import { cn } from "../cn.ts";

const labelVariants = cva(
  "text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
);

function Label({ className, ...props }: React.ComponentProps<"label">) {
  return <label className={cn(labelVariants(), className)} {...props} />;
}

export { Label };
