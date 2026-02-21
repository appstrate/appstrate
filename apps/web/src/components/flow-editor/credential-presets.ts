import type { SchemaField } from "./schema-section";

export type CredentialPresetId =
  | "api_key"
  | "bearer_token"
  | "credentials_username"
  | "credentials_email"
  | "custom";

export interface CredentialPreset {
  id: CredentialPresetId;
  labelKey: string;
  fields: { key: string; type: string; description: string; required: boolean }[];
}

export const CREDENTIAL_PRESETS: CredentialPreset[] = [
  {
    id: "api_key",
    labelKey: "editor.presetApiKey",
    fields: [{ key: "api_key", type: "string", description: "API Key", required: true }],
  },
  {
    id: "bearer_token",
    labelKey: "editor.presetBearerToken",
    fields: [{ key: "token", type: "string", description: "Bearer Token", required: true }],
  },
  {
    id: "credentials_username",
    labelKey: "editor.presetCredentialsUsername",
    fields: [
      { key: "username", type: "string", description: "Username", required: true },
      { key: "password", type: "string", description: "Password", required: true },
    ],
  },
  {
    id: "credentials_email",
    labelKey: "editor.presetCredentialsEmail",
    fields: [
      { key: "email", type: "string", description: "Email", required: true },
      { key: "password", type: "string", description: "Password", required: true },
    ],
  },
  {
    id: "custom",
    labelKey: "editor.presetCustom",
    fields: [],
  },
];

export function presetToFields(presetId: CredentialPresetId): SchemaField[] {
  const preset = CREDENTIAL_PRESETS.find((p) => p.id === presetId);
  if (!preset || preset.id === "custom") return [];
  return preset.fields.map((f) => ({
    _id: crypto.randomUUID(),
    key: f.key,
    type: f.type,
    description: f.description,
    required: f.required,
  }));
}

export function detectPreset(fields: SchemaField[]): CredentialPresetId {
  if (fields.length === 0) return "custom";

  for (const preset of CREDENTIAL_PRESETS) {
    if (preset.id === "custom") continue;
    if (fields.length !== preset.fields.length) continue;

    const match = preset.fields.every((pf, i) => {
      const sf = fields[i];
      return sf.key === pf.key && sf.type === pf.type && sf.required === pf.required;
    });

    if (match) return preset.id;
  }

  return "custom";
}
