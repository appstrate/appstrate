// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

/** The endpoint of a model gateway. Not `z.httpUrl()`: that one refuses the IP or `localhost` of a self-hosted endpoint. */
export const endpointUrlSchema = z.url({ protocol: /^https?$/ });
