export interface ModelPreset {
  modelId: string;
  label: string;
  input: string[];
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
}

export interface ProviderPreset {
  id: string;
  label: string;
  api: string;
  baseUrl: string;
  models: ModelPreset[];
}

export const CUSTOM_ID = "__custom__";

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "anthropic",
    label: "Anthropic",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    models: [
      {
        modelId: "claude-opus-4-6",
        label: "Claude Opus 4.6",
        input: ["text", "image"],
        contextWindow: 200_000,
        maxTokens: 128_000,
        reasoning: true,
      },
      {
        modelId: "claude-sonnet-4-6",
        label: "Claude Sonnet 4.6",
        input: ["text", "image"],
        contextWindow: 200_000,
        maxTokens: 64_000,
        reasoning: true,
      },
      {
        modelId: "claude-haiku-4-5-20251001",
        label: "Claude Haiku 4.5",
        input: ["text", "image"],
        contextWindow: 200_000,
        maxTokens: 64_000,
        reasoning: true,
      },
    ],
  },
  {
    id: "openai",
    label: "OpenAI",
    api: "openai-completions",
    baseUrl: "https://api.openai.com/v1",
    models: [
      {
        modelId: "gpt-5.4",
        label: "GPT-5.4",
        input: ["text", "image"],
        contextWindow: 1_050_000,
        maxTokens: 128_000,
        reasoning: true,
      },
      {
        modelId: "gpt-5-mini",
        label: "GPT-5 mini",
        input: ["text", "image"],
        contextWindow: 400_000,
        maxTokens: 128_000,
        reasoning: true,
      },
      {
        modelId: "o4-mini",
        label: "o4-mini",
        input: ["text", "image"],
        contextWindow: 200_000,
        maxTokens: 100_000,
        reasoning: true,
      },
    ],
  },
  {
    id: "google-ai",
    label: "Google AI",
    api: "google-generative-ai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    models: [
      {
        modelId: "gemini-3.1-pro-preview",
        label: "Gemini 3.1 Pro",
        input: ["text", "image"],
        contextWindow: 1_048_576,
        maxTokens: 65_536,
        reasoning: true,
      },
      {
        modelId: "gemini-2.5-pro",
        label: "Gemini 2.5 Pro",
        input: ["text", "image"],
        contextWindow: 1_048_576,
        maxTokens: 65_536,
        reasoning: true,
      },
      {
        modelId: "gemini-2.5-flash",
        label: "Gemini 2.5 Flash",
        input: ["text", "image"],
        contextWindow: 1_048_576,
        maxTokens: 65_536,
        reasoning: true,
      },
    ],
  },
];

export function findPresetMatch(
  api: string,
  modelId: string,
): { provider: ProviderPreset; model: ModelPreset } | null {
  for (const provider of PROVIDER_PRESETS) {
    if (provider.api !== api) continue;
    const model = provider.models.find((m) => m.modelId === modelId);
    if (model) return { provider, model };
  }
  return null;
}

export function getProviderById(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id);
}

export function getProviderByApi(api: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.api === api);
}
