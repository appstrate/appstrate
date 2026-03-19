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
  {
    id: "mistral",
    label: "Mistral",
    api: "openai-completions",
    baseUrl: "https://api.mistral.ai/v1",
    models: [
      {
        modelId: "mistral-large-latest",
        label: "Mistral Large",
        input: ["text", "image"],
        contextWindow: 128_000,
        maxTokens: 32_768,
        reasoning: false,
      },
      {
        modelId: "mistral-medium-latest",
        label: "Mistral Medium",
        input: ["text"],
        contextWindow: 128_000,
        maxTokens: 32_768,
        reasoning: false,
      },
      {
        modelId: "mistral-small-latest",
        label: "Mistral Small",
        input: ["text", "image"],
        contextWindow: 128_000,
        maxTokens: 32_768,
        reasoning: false,
      },
      {
        modelId: "codestral-latest",
        label: "Codestral",
        input: ["text"],
        contextWindow: 256_000,
        maxTokens: 32_768,
        reasoning: false,
      },
    ],
  },
  {
    id: "xai",
    label: "xAI",
    api: "openai-completions",
    baseUrl: "https://api.x.ai/v1",
    models: [
      {
        modelId: "grok-4",
        label: "Grok 4",
        input: ["text", "image"],
        contextWindow: 131_072,
        maxTokens: 65_536,
        reasoning: true,
      },
      {
        modelId: "grok-3",
        label: "Grok 3",
        input: ["text", "image"],
        contextWindow: 131_072,
        maxTokens: 65_536,
        reasoning: false,
      },
      {
        modelId: "grok-3-mini",
        label: "Grok 3 Mini",
        input: ["text", "image"],
        contextWindow: 131_072,
        maxTokens: 65_536,
        reasoning: true,
      },
    ],
  },
  {
    id: "groq",
    label: "Groq",
    api: "openai-completions",
    baseUrl: "https://api.groq.com/openai/v1",
    models: [
      {
        modelId: "llama-3.3-70b-versatile",
        label: "Llama 3.3 70B",
        input: ["text", "image"],
        contextWindow: 131_072,
        maxTokens: 32_768,
        reasoning: false,
      },
      {
        modelId: "gemma2-9b-it",
        label: "Gemma 2 9B",
        input: ["text"],
        contextWindow: 8_192,
        maxTokens: 8_192,
        reasoning: false,
      },
      {
        modelId: "mixtral-8x7b-32768",
        label: "Mixtral 8x7B",
        input: ["text"],
        contextWindow: 32_768,
        maxTokens: 32_768,
        reasoning: false,
      },
    ],
  },
  {
    id: "cerebras",
    label: "Cerebras",
    api: "openai-completions",
    baseUrl: "https://api.cerebras.ai/v1",
    models: [
      {
        modelId: "llama-4-scout-17b-16e-instruct",
        label: "Llama 4 Scout",
        input: ["text", "image"],
        contextWindow: 131_072,
        maxTokens: 16_384,
        reasoning: false,
      },
      {
        modelId: "llama3.3-70b",
        label: "Llama 3.3 70B",
        input: ["text"],
        contextWindow: 131_072,
        maxTokens: 16_384,
        reasoning: false,
      },
    ],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    api: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1",
    models: [],
  },
];

/**
 * Supported API types for the Pi SDK.
 * Used by the custom provider form to offer all available adapter options.
 */
export const API_TYPES = [
  { value: "openai-completions", label: "OpenAI / Compatible" },
  { value: "openai-responses", label: "OpenAI Responses" },
  { value: "anthropic-messages", label: "Anthropic" },
  { value: "google-generative-ai", label: "Google AI" },
  { value: "google-vertex", label: "Google Vertex AI" },
  { value: "azure-openai-responses", label: "Azure OpenAI" },
  { value: "bedrock-converse-stream", label: "AWS Bedrock" },
] as const;

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

export function findProviderByApiAndBaseUrl(
  api: string,
  baseUrl: string | undefined,
): ProviderPreset | undefined {
  if (!baseUrl) return undefined;
  const normalized = baseUrl.replace(/\/+$/, "");
  return PROVIDER_PRESETS.find(
    (p) => p.api === api && normalized.startsWith(p.baseUrl.replace(/\/+$/, "")),
  );
}
