// SPDX-License-Identifier: Apache-2.0

import { $isDirectiveNode } from "@assistant-ui/react-lexical";
import type { LexicalNode } from "lexical";

/** Deletes the node if it is a directive chip. Call inside an `editor.update`: one undoable step. */
export function $removeDirectiveChip(node: LexicalNode | null | undefined): boolean {
  if (!$isDirectiveNode(node)) return false;
  node.remove();
  return true;
}
