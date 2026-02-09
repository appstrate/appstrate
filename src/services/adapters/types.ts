export interface ExecutionMessage {
  type: "progress" | "result";
  message?: string;
  data?: Record<string, unknown>;
}

export interface ExecutionAdapter {
  execute(
    executionId: string,
    envVars: Record<string, string>,
    flowPath: string,
    timeout: number,
  ): AsyncGenerator<ExecutionMessage>;
}
