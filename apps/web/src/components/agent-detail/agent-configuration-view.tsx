// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import type { AgentDetail } from "@appstrate/shared-types";
import type { SchemaWrapper } from "@appstrate/core/form";
import { AgentConfigurationTab } from "../package-detail/agent-configuration-tab";
import { AgentConnectionsSection } from "../package-detail/agent-connections-section";
import { AgentSchedulesTab } from "../package-detail/agent-tabs";
import { SettingsHeading } from "../settings/settings-heading";
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

  return (
    <section className="min-w-0 p-6">
      <SettingsHeading title={t(text.labelKey)} description={t(text.descriptionKey)} />
      <div>{sectionBody}</div>
    </section>
  );
}
