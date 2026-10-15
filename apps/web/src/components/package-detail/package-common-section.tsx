// SPDX-License-Identifier: Apache-2.0

/** The Paramètres sections every package has: files tree, versions, and the `bundle` file table. */
import type { ComponentProps } from "react";
import type { PackageType } from "@appstrate/core/validation";
import { PackageFilesSection } from "../package-files/package-files-section";
import { PackageFilesView } from "../package-files/package-files-view";
import type { PackageCommonSectionId } from "../../lib/settings-section-href";
import type { SettingsHref } from "../settings/settings-rail-view";
import { PackageVersionsSection } from "./package-versions-section";

export type PackageVersionsProps = Omit<
  ComponentProps<typeof PackageVersionsSection>,
  "type" | "packageId"
>;

export function PackageCommonSection<S extends string>({
  section,
  type,
  packageId,
  manifest,
  file,
  href,
  version,
  manifestSection,
  versions,
}: {
  section: PackageCommonSectionId;
  type: PackageType;
  packageId: string;
  manifest: Record<string, unknown>;
  /** The file the tree opens on. */
  file: string | undefined;
  href: SettingsHref<S | "files">;
  /** A pinned version being read. */
  version?: string;
  /** Section whose editor holds the raw manifest, when the reader may write the package. */
  manifestSection?: S;
  versions: PackageVersionsProps;
}) {
  if (section === "versions") {
    return <PackageVersionsSection type={type} packageId={packageId} {...versions} />;
  }
  if (section === "bundle") {
    return (
      <PackageFilesSection
        type={type}
        packageId={packageId}
        manifest={manifest}
        filesHref={(path) => href("files", { file: path })}
      />
    );
  }
  return (
    <PackageFilesView
      key={file}
      type={type}
      packageId={packageId}
      initialVersion={version}
      initialPath={file}
      editable={manifestSection !== undefined}
      editHref={
        manifestSection === undefined
          ? undefined
          : (path) =>
              path === "manifest.json" ? href(manifestSection, { editManifest: "1" }) : undefined
      }
    />
  );
}
