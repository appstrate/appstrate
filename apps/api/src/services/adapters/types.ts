export interface ExecutionMessage {
  type: "progress" | "result";
  message?: string;
  data?: Record<string, unknown>;
}

export interface ExecutionAdapter {
  execute(
    executionId: string,
    envVars: Record<string, string>,
    timeout: number,
    outputSchema?: Record<string, import("@appstrate/shared-types").FlowOutputField>,
  ): AsyncGenerator<ExecutionMessage>;
}
