// SPDX-License-Identifier: Apache-2.0

import { jsonText } from "@appstrate/afps-shared/json-text";
/** Form-state model of an end-user's `metadata`, shared by the create and edit forms. */

type MetadataValue = string | number | boolean | null;

export interface MetadataEntry {
  key: string;
  value: string;
  /**
   * Original typed value for entries loaded from the server. Preserved so
   * an untouched number/boolean/null round-trips as its own type instead of
   * being stringified (`30` must not become `"30"`). Absent for new rows.
   */
  original?: MetadataValue;
}

export function metadataToEntries(metadata: Record<string, unknown> | null): MetadataEntry[] {
  if (!metadata) return [];
  return Object.entries(metadata).map(([key, value]) => ({
    key,
    value: jsonText(value),
    original: isMetadataValue(value) ? value : undefined,
  }));
}

function isMetadataValue(value: unknown): value is MetadataValue {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

/**
 * Resolve an entry back to its wire value. New rows and originally-string
 * values keep the raw text; a non-string original returns verbatim when
 * untouched, and re-parses to a scalar when edited (falling back to the raw
 * string when the edit is not valid JSON or is not a scalar).
 */
function coerceEntryValue(entry: MetadataEntry): MetadataValue {
  if (entry.original === undefined || typeof entry.original === "string") {
    return entry.value;
  }
  if (JSON.stringify(entry.original) === entry.value) return entry.original;
  try {
    const parsed: unknown = JSON.parse(entry.value);
    return isMetadataValue(parsed) ? parsed : entry.value;
  } catch {
    return entry.value;
  }
}

export function entriesToMetadata(entries: MetadataEntry[]): Record<string, MetadataValue> {
  const result: Record<string, MetadataValue> = {};
  for (const entry of entries) {
    const k = entry.key.trim();
    if (k) result[k] = coerceEntryValue(entry);
  }
  return result;
}
