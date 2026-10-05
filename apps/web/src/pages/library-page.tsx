// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { PackageLibrary, SpacePackageLibrary } from "../components/package-library";
import { LoadingState, ErrorState } from "../components/page-states";
import { useLibrary, useSpaceLibrary } from "../hooks/use-library";

export function LibraryPage() {
  const { t } = useTranslation();
  const { data, isLoading, error } = useLibrary();
  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState error={error} />;
  return data ? <PackageLibrary data={data} title={t("library.title")} /> : null;
}

export function SpacePackagesPage() {
  const { t } = useTranslation();
  const { data, isLoading, error } = useSpaceLibrary();
  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState error={error} />;
  return data ? <SpacePackageLibrary data={data} title={t("library.spaceTitle")} /> : null;
}
