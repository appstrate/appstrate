// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import type { PackageType } from "@appstrate/core/validation";
import type { BreadcrumbEntry } from "../stores/breadcrumb-store";
import { packageListPath } from "../lib/package-paths";

/** The first crumb of a package's page: its family's list. */
export function usePackageListCrumb(type: PackageType): BreadcrumbEntry {
  const { t } = useTranslation(["agents", "settings"]);
  return {
    label:
      type === "agent" ? t("detail.breadcrumb") : t(`packages.type.${type}s`, { ns: "settings" }),
    href: packageListPath(type),
  };
}
