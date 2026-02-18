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

export interface ExecutionAdapter {
  execute(
    executionId: string,
    envVars: Record<string, string>,
    timeout: number,
    outputSchema?: import("@appstrate/shared-types").JSONSchemaObject,
    flowPackage?: Buffer,
    files?: FileReference[],
  ): AsyncGenerator<ExecutionMessage>;
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}
