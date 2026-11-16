// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import type { ChatTranslate } from "./runtime-context.ts";

const NAME_SLOT = "\u0000";

/*
 * Both helpers return ONE inline span holding the sentence. Siblings would each become a flex item
 * inside a flex parent (menu item, chip) and the text's trailing/leading space would be dropped
 * (« Limiter àStudio »): inside the wrapper the sentence stays a single inline formatting context.
 */

/** A translated sentence whose `{{name}}` renders in bold. */
export function sentenceWithName(t: ChatTranslate, key: string, name: string): ReactNode {
  const [before, after = ""] = t(key, { name: NAME_SLOT }).split(NAME_SLOT);
  return (
    <span>
      {before}
      <span className="font-medium">{name}</span>
      {after}
    </span>
  );
}

/** {@link sentenceWithName} where the name is a node (a space's tile and name, as the host renders it). */
export function sentenceWithNode(t: ChatTranslate, key: string, node: ReactNode): ReactNode {
  const [before, after = ""] = t(key, { name: NAME_SLOT }).split(NAME_SLOT);
  return (
    <span>
      {before}
      {node}
      {after}
    </span>
  );
}
