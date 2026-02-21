export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cost_usd?: number;
}

export interface ExecutionMessage {
  type: "progress" | "result";
  message?: string;
  data?: Record<string, unknown>;
  usage?: TokenUsage;
}

export interface UploadedFile {
  fieldName: string;
  name: string;
  type: string;
  size: number;
  buffer: Buffer;
}

export interface FileReference {
  fieldName: string;
  name: string;
  type: string;
  size: number;
  url: string;
}

export interface PromptContext {
  rawPrompt: string;
  tokens: Record<string, string>;
  config: Record<string, unknown>;
  previousState: Record<string, unknown> | null;
  executionApi?: { url: string; token: string };
  input: Record<string, unknown>;
  files?: FileReference[];
  schemas: {
    input?: import("@appstrate/shared-types").JSONSchemaObject;
    config?: import("@appstrate/shared-types").JSONSchemaObject;
    output?: import("@appstrate/shared-types").JSONSchemaObject;
  };
  services: Array<{
    id: string;
    name?: string;
    provider: string;
    description: string;
    schema?: import("@appstrate/shared-types").JSONSchemaObject;
    authorized_uris?: string[];
    allow_all_uris?: boolean;
  }>;
  llmModel: string;
}

export interface ExecutionAdapter {
  execute(
    executionId: string,
    ctx: PromptContext,
    timeout: number,
    flowPackage?: Buffer,
    signal?: AbortSignal,
  ): AsyncGenerator<ExecutionMessage>;
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}
