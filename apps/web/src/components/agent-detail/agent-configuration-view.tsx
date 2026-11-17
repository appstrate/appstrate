// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { ChevronsUpDown } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import type { AgentDetail } from "@appstrate/shared-types";
import type { SchemaWrapper } from "@appstrate/core/form";
import { AgentConfigurationTab } from "../package-detail/agent-configuration-tab";
import { AgentConnectionsSection } from "../package-detail/agent-connections-section";
import { AgentSchedulesTab } from "../package-detail/agent-tabs";
import { SettingsHeading } from "../settings/settings-heading";
import { SpaceChoiceDropdown } from "../space-choice-menu";
import { SpaceNameOf } from "../space-name";
import { ModelRequiredAlert } from "./model-required-alert";
import { useAgentSpaceAction } from "../../hooks/use-agent-run-space";
import { useAgentModelBlocker } from "../../hooks/use-agent-readiness";
import { useCurrentSpaceId } from "../../hooks/use-current-space";
import { useOverviewMode } from "../../hooks/use-overview-mode";
import { useSpacesFor } from "../../hooks/use-space-action";
import { useSpaces } from "../../hooks/use-spaces";
import { spaceLabel } from "../../lib/space-label";
import type { ConfigurationSection } from "../../lib/settings-section-href";

const CONFIGURATION_SECTION_TEXT: Record<
  ConfigurationSection,
  { labelKey: string; descriptionKey: string }
> = {
  model: {
    labelKey: "detail.configuration.model",
    descriptionKey: "detail.configuration.modelIntro",
  },
  proxy: {
    labelKey: "detail.configSectionProxy",
    descriptionKey: "detail.configuration.proxyIntro",
  },
  inputs: {
    labelKey: "detail.configuration.inputsShort",
    descriptionKey: "detail.configuration.inputsDescription",
  },
  connections: {
    labelKey: "detail.configuration.connections",
    descriptionKey: "detail.configuration.connectionsDescription",
  },
  schedules: {
    labelKey: "detail.configuration.schedulesShort",
    descriptionKey: "detail.configuration.schedulesDescription",
  },
};

/** The sections set in one space (`space_packages`): in « Tous les espaces », that space is named. */
const isSpaceSetting = (section: ConfigurationSection) => section !== "schedules";

/**
 * The space whose configuration the view shows, in « Tous les espaces »: the working space, named,
 * and the menu of the agent's other spaces the reader configures. Picking one enters it, the
 * agent already read there, so every read and write below is that space's.
 */
function ConfigurationSpace({
  packageId,
  spaceIds,
}: {
  packageId: string;
  spaceIds: readonly string[];
}) {
  const { t } = useTranslation("agents");
  const workingSpaceId = useCurrentSpaceId();
  const enter = useAgentSpaceAction(packageId, "agents:configure", spaceIds, {
    preferWorkingSpace: false,
  });
  const { eligible } = useSpacesFor({ permission: "agents:configure" }, spaceIds);
  const choice = enter.choose(t("detail.configuration.spaceChoice"), () => enter.enteredDetail());
  // Elsewhere than here: a menu between several, the one other space at a click.
  const elsewhere = eligible.some((space) => space.id !== workingSpaceId);

  return (
    <div className="mb-6 flex flex-wrap items-center gap-2 text-sm" data-configuration-space>
      <span className="text-muted-foreground">{t("detail.configuration.spaceLabel")}</span>
      {elsewhere ? (
        <SpaceChoiceDropdown choice={choice}>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={enter.entering}
            onClick={choice ? undefined : () => enter.run(() => enter.enteredDetail())}
          >
            <SpaceNameOf spaceId={workingSpaceId} />
            <ChevronsUpDown className="text-muted-foreground" aria-hidden />
          </Button>
        </SpaceChoiceDropdown>
      ) : (
        <SpaceNameOf spaceId={workingSpaceId} size="md" />
      )}
    </div>
  );
}

/** A model missing in the named space only (no default, no pin there); one missing everywhere is said by the page. */
function SpaceModelAlert({ packageId }: { packageId: string }) {
  const blocker = useAgentModelBlocker(packageId);
  return <ModelRequiredAlert blocker={blocker === "detail.titleNoDefaultModel" ? blocker : null} />;
}

export function AgentConfigurationView({
  packageId,
  detail,
  inputWrapperOverride,
  isHistorical,
  section,
}: {
  packageId: string;
  detail: AgentDetail;
  /** The pinned version's input wrapper, when a version is pinned. */
  inputWrapperOverride?: SchemaWrapper;
  isHistorical?: boolean;
  section: ConfigurationSection;
}) {
  const { t } = useTranslation("agents");
  const { on: overview } = useOverviewMode();
  const workingSpaceId = useCurrentSpaceId();
  const { data: spaces } = useSpaces();
  const workingSpace = spaces?.find((space) => space.id === workingSpaceId);
  const namesSpace = overview && isSpaceSetting(section);
  const sharedConfigurationProps = {
    packageId,
    inputWrapperOverride,
    isHistorical,
  };

  const sectionBody = (() => {
    if (section === "model" || section === "proxy" || section === "inputs") {
      return <AgentConfigurationTab {...sharedConfigurationProps} section={section} />;
    }
    // Both are set per space, whatever version is being read.
    if (section === "connections") {
      return <AgentConnectionsSection packageId={packageId} detail={detail} />;
    }
    return <AgentSchedulesTab packageId={packageId} />;
  })();

  const text = CONFIGURATION_SECTION_TEXT[section];
  // « Cet espace » is the named one only once it is named.
  const description =
    section === "connections" && namesSpace && workingSpace
      ? t("detail.configuration.connectionsDescriptionIn", {
          space: spaceLabel(workingSpace, t),
        })
      : t(text.descriptionKey);

  return (
    <section className="min-w-0 p-6">
      {namesSpace && <ConfigurationSpace packageId={packageId} spaceIds={detail.space_ids} />}
      {namesSpace && section === "model" && <SpaceModelAlert packageId={packageId} />}
      <SettingsHeading title={t(text.labelKey)} description={description} />
      <div>{sectionBody}</div>
    </section>
  );
}
