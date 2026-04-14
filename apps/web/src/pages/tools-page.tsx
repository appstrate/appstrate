// SPDX-License-Identifier: Apache-2.0

import { ItemTab } from "./item-tab";
import { toolTabConfig } from "./item-tab-configs";

export function ToolsPage() {
  return (
    <div className="p-6">
      <ItemTab config={toolTabConfig} />
    </div>
  );
}
