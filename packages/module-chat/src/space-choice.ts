// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

const choiceTarget = z.object({
  tool: z.string().min(1),
  operationId: z.string().min(1).optional(),
});

function specifiesOperation(choice: z.infer<typeof choiceTarget>) {
  return (choice.tool === "invoke_operation") === (choice.operationId !== undefined);
}

/** The chosen destination applies throughout the answering turn to the same tool and, for invoke_operation, the same operation. */
export const spaceChoiceSchema = choiceTarget
  .extend({ spaceId: z.string().min(1) })
  .refine(specifiesOperation);
export type SpaceChoice = z.infer<typeof spaceChoiceSchema>;

export const pendingSpaceChoiceSchema = choiceTarget
  .extend({
    spaceIds: z.array(z.string().min(1)).nonempty(),
  })
  .refine(specifiesOperation);
export type PendingSpaceChoice = z.infer<typeof pendingSpaceChoiceSchema>;
export const SPACE_CHOICE_PART = "data-space-choice";
