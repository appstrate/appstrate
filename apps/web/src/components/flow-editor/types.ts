import type { ServiceEntry } from "./services-section";
import type { SchemaField } from "./schema-section";
import type { ExecutionSettings } from "./execution-section";
import type { SkillEntry } from "./skills-section";

export type EditorTab = "general" | "prompt" | "services" | "schema" | "skills";

export interface FlowFormState {
  metadata: {
    name: string;
    displayName: string;
    description: string;
    tags: string[];
  };
  prompt: string;
  services: ServiceEntry[];
  inputSchema: SchemaField[];
  outputSchema: SchemaField[];
  configSchema: SchemaField[];
  stateSchema: SchemaField[];
  execution: ExecutionSettings;
  skills: SkillEntry[];
}
