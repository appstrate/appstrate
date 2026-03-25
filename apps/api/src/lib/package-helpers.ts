import { eq, or, isNull } from "drizzle-orm";
import { packages } from "@appstrate/db/schema";
import { asRecord } from "./safe-json.ts";

/** Drizzle filter: packages owned by org OR system packages (orgId: null). */
export function orgOrSystemFilter(orgId: string) {
  return or(eq(packages.orgId, orgId), isNull(packages.orgId))!;
}

/** Extract displayName from a package's draftManifest JSONB, falling back to the package ID. */
export function getPackageDisplayName(pkg: { id: string; draftManifest: unknown }): string {
  const m = asRecord(pkg.draftManifest);
  return typeof m.displayName === "string" ? m.displayName : pkg.id;
}
