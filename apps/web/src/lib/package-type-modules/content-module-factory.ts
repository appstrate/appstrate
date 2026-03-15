import type { PackageTypeModule, PackageFormState, ContentPackageInput } from "./index";

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
      const scopeMatch = detail.id.match(/^@([^/]+)\/(.+)$/);
      return {
        _type: type,
        metadata: {
          id: scopeMatch ? scopeMatch[2] : detail.id,
          scope: scopeMatch ? scopeMatch[1] : "",
          version: detail.version ?? "1.0.0",
          displayName: detail.displayName,
          description: detail.description,
          author: "",
          keywords: [],
        },
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
        _manifestBase: { schemaVersion: "1.0", type },
      };
    },

    assemblePayload(state: PackageFormState): Record<string, unknown> {
      if (state._type !== type) throw new Error(`Expected ${type} form state`);
      const scopedName = state.metadata.scope
        ? `@${state.metadata.scope}/${state.metadata.id}`
        : undefined;
      return {
        manifest: {
          ...state._manifestBase,
          type: state._type,
          version: state.metadata.version,
          displayName: state.metadata.displayName,
          description: state.metadata.description,
          ...(scopedName ? { name: scopedName } : {}),
        },
        content: state.content,
      };
    },
  };
}
