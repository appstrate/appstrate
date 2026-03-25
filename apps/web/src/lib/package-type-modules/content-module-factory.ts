import type { PackageTypeModule, PackageFormState, ContentPackageInput } from "./index";
import { AFPS_SCHEMA_URLS } from "@appstrate/core/validation";
import { manifestToMetadata, metadataToManifestPatch } from "../../components/flow-editor/utils";

/**
 * Factory for skill/tool modules — they share identical logic
 * for detailToFormState and assemblePayload.
 * Only the default content template and _manifestBase differ.
 */
export function makeContentPackageModule(
  type: "skill" | "tool",
  defaultContent: string,
): PackageTypeModule {
  return {
    detailToFormState(detail: ContentPackageInput): PackageFormState {
      const metadata = manifestToMetadata({
        name: detail.id,
        version: detail.version,
        displayName: detail.displayName,
        description: detail.description,
        ...(detail.manifest ?? {}),
      });
      return {
        _type: type,
        metadata,
        content: detail.content ?? "",
        _manifestBase: detail.manifest ?? {},
        _lockVersion: detail.lockVersion,
      };
    },

    defaultFormState(orgSlug?: string, _userEmail?: string): PackageFormState {
      return {
        _type: type,
        metadata: {
          id: "",
          scope: orgSlug ?? "",
          version: "1.0.0",
          displayName: "",
          description: "",
          author: "",
          keywords: [],
        },
        content: defaultContent,
        _manifestBase: { $schema: AFPS_SCHEMA_URLS[type], schemaVersion: "1.0", type },
      };
    },

    assemblePayload(state: PackageFormState): Record<string, unknown> {
      if (state._type !== type) throw new Error(`Expected ${type} form state`);
      const metaPatch = metadataToManifestPatch(state.metadata);
      const manifest: Record<string, unknown> = {
        $schema: AFPS_SCHEMA_URLS[type],
        schemaVersion: "1.0",
        ...state._manifestBase,
        type: state._type,
        ...metaPatch,
      };

      // Tool packages require entrypoint + tool interface in manifest
      if (type === "tool") {
        manifest.entrypoint = "tool.ts";
        manifest.tool = {
          name: state.metadata.id || "my_tool",
          description: state.metadata.description || state.metadata.displayName || "Tool",
          inputSchema: { type: "object", properties: {} },
        };
      }

      return { manifest, content: state.content };
    },
  };
}
