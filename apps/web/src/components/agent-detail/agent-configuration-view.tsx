// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import type { AgentDetail } from "@appstrate/shared-types";
import type { SchemaWrapper } from "@appstrate/core/form";
import { AgentConfigurationTab } from "../package-detail/agent-configuration-tab";
import { AgentConnectionsSection } from "../package-detail/agent-connections-section";
import { AgentSchedulesTab } from "../package-detail/agent-tabs";
import { SettingsHeading } from "../settings/settings-heading";
import { ConfigurationSpace } from "../configuration-space";
import { ModelRequiredAlert } from "./model-required-alert";
import { useAgentSpaceAction } from "../../hooks/use-agent-run-space";
import { useAgentModelBlocker } from "../../hooks/use-agent-readiness";
import { useOverviewMode, useWorkingSpaceWording } from "../../hooks/use-overview-mode";
import { isSpaceSetting } from "../../lib/agent-settings-sections";
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

/**
 * The space an agent's section is shown from, in « Tous les espaces » (`ConfigurationSpace`):
 * one of `spaceIds` granting `permission` — its active spaces (`space_ids`, the header's tiles)
 * for a space setting — the agent read there on entering.
 */
export function AgentConfigurationSpace({
  packageId,
  spaceIds,
  permission,
}: {
  packageId: string;
  spaceIds: readonly string[];
  permission: string;
}) {
  const { t } = useTranslation("agents");
  const enter = useAgentSpaceAction(packageId, permission, spaceIds);
  return (
    <ConfigurationSpace
      label={t("detail.configuration.spaceLabel")}
      choiceLabel={t("detail.configuration.spaceChoice")}
      spaceIds={spaceIds}
      enter={enter}
    />
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
  permission,
}: {
  packageId: string;
  detail: AgentDetail;
  /** What the section asks of the space it is set in; absent for the schedules, which span them. */
  permission?: string;
  /** The pinned version's input wrapper, when a version is pinned. */
  inputWrapperOverride?: SchemaWrapper;
  isHistorical?: boolean;
  section: ConfigurationSection;
}) {
  const { t } = useTranslation("agents");
  const { on: overview } = useOverviewMode();
  const spaceWording = useWorkingSpaceWording("agents");
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
  const description =
    section === "connections"
      ? spaceWording(text.descriptionKey, "detail.configuration.connectionsDescriptionIn")
      : t(text.descriptionKey);

  return (
    <section className="min-w-0 p-6">
      {namesSpace && permission && (
        <AgentConfigurationSpace
          packageId={packageId}
          spaceIds={detail.space_ids}
          permission={permission}
        />
      )}
      {namesSpace && section === "model" && <SpaceModelAlert packageId={packageId} />}
      <SettingsHeading title={t(text.labelKey)} description={description} />
      <div>{sectionBody}</div>
    </section>
  );
}
