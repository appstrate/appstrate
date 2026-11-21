// SPDX-License-Identifier: Apache-2.0

import type { Sql } from "postgres";

export interface ListenClient {
  listen(channel: string, handler: (payload: string) => void): Promise<void>;
}

export function createListenClient(conn: Sql): ListenClient {
  return {
    listen: async (channel, handler) => {
      await conn.listen(channel, handler);
    },
  };
}
