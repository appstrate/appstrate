import { ItemTab } from "./item-tab";
import { extensionTabConfig } from "./item-tab-configs";

export function ExtensionsPage() {
  return <ItemTab config={extensionTabConfig} />;
}
