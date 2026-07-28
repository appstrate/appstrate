// SPDX-License-Identifier: Apache-2.0

/**
 * The agent's "Map" tab, which now holds two maps rather than one.
 *
 * They answer two different questions and must not be confused: the dependency
 * map says what the agent CAN do (an exact projection of its manifest crossed
 * with the installation), the logic map says what its prompt SAYS IT DOES (an
 * inference over free text, which can be absent, stale or wrong).
 *
 * Hence a sub-tab rather than a split screen: putting an exact drawing and an
 * inferred one side by side would suggest they carry the same authority.
 */

import { useState } from "react";
import { Tabs, TabsList, TabsTrigger } from "@appstrate/ui/components/tabs";
import { useTranslation } from "react-i18next";
import { AgentMapView } from "./agent-map-view";
import { AgentLogicMapView } from "./agent-logic-map-view";

type MapKind = "dependencies" | "logic";

export function AgentMapsTab({
  packageId,
  version,
}: {
  packageId: string;
  version?: string | undefined;
}) {
  const { t } = useTranslation("agents");
  // Les dépendances par défaut : elles sont exactes, et c'est ce qu'on vient
  // vérifier le plus souvent.
  const [kind, setKind] = useState<MapKind>("dependencies");

  return (
    <div>
      <Tabs value={kind} onValueChange={(v) => setKind(v as MapKind)} className="mb-3">
        <TabsList>
          <TabsTrigger value="dependencies">{t("map.tabs.dependencies")}</TabsTrigger>
          <TabsTrigger value="logic">{t("map.tabs.logic")}</TabsTrigger>
        </TabsList>
      </Tabs>

      {kind === "dependencies" ? (
        // Une version historique projette le manifeste qu'elle épingle, pour que
        // le dessin corresponde à la définition inspectée.
        <AgentMapView packageId={packageId} version={version} />
      ) : (
        <AgentLogicMapView packageId={packageId} version={version} />
      )}
    </div>
  );
}
