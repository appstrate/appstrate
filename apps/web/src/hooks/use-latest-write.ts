// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { createLatestWriter } from "../lib/latest-write";

/** A `createLatestWriter` that lives as long as the component. */
export function useLatestWrite() {
  const [write] = useState(createLatestWriter);
  return write;
}
