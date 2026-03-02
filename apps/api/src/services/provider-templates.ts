import type { ProviderTemplate } from "@appstrate/shared-types";
import templatesData from "./provider-templates.json";

const providerTemplates = templatesData as ProviderTemplate[];

export function getProviderTemplates(): ProviderTemplate[] {
  return providerTemplates;
}
