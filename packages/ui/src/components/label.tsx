// SPDX-License-Identifier: Apache-2.0

import * as React from "react";

import { cn } from "../cn.ts";

const LABEL_CLASS =
  "text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70";

function Label({ className, ...props }: React.ComponentProps<"label">) {
  return <label className={cn(LABEL_CLASS, className)} {...props} />;
}

export { Label };
