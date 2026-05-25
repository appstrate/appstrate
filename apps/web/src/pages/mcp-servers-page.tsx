// SPDX-License-Identifier: Apache-2.0

import { ItemTab } from "./item-tab";

export function McpServersPage() {
  return (
    <div className="p-6">
      <ItemTab type="mcp-server" readOnly />
    </div>
  );
}
