// SPDX-License-Identifier: Apache-2.0

import { ItemTab } from "./item-tab";
import { skillTabConfig } from "./item-tab-configs";

export function SkillsPage() {
  return (
    <div className="p-6">
      <ItemTab config={skillTabConfig} />
    </div>
  );
}
