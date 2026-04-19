// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

export const profileNameSchema = z.object({
  name: z.string().min(1, "Name is required").max(100),
});
