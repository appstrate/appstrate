// SPDX-License-Identifier: Apache-2.0

/**
 * Pure helpers for the Agent/Run rendered contract.
 *
 * The browser walker lives in `detail-contract.mjs`; these functions stay free
 * of Playwright so Bun can test the comparison and invariant logic directly.
 */

export const CONTRACT_VERSION = 1;

export function contractKey(screen, width) {
  return `${screen}@${width}`;
}

export function normalizeLandmarkLabel(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\d{1,4}[/-]\d{1,2}[/-]\d{1,4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?/g, "<date>")
    .replace(/\bv?\d+\.\d+(?:\.\d+)?\b/gi, "<version>")
    .replace(/\b\d+(?:[.,]\d+)?\b/g, "<n>")
    .slice(0, 96);
}

export function assertRenderedInvariants(entry) {
  const failures = [];
  const { screen, width, document, landmarks } = entry;
  const prefix = `${screen} at ${width}px`;

  if (document.viewportOverflow > 1) {
    failures.push(`${prefix}: viewport overflows horizontally by ${document.viewportOverflow}px`);
  }
  if (document.mainOverflow > 1) {
    failures.push(`${prefix}: main content overflows horizontally by ${document.mainOverflow}px`);
  }
  if (document.clippedInteractiveCount > 0) {
    failures.push(
      `${prefix}: ${document.clippedInteractiveCount} interactive element(s) are clipped by the viewport`,
    );
  }
  if (document.localTablistCount !== 1) {
    failures.push(
      `${prefix}: expected one visible Agent/Run tablist, got ${document.localTablistCount}`,
    );
  }
  if (document.activeLocalTabCount !== 1) {
    failures.push(
      `${prefix}: expected one active Agent/Run tab, got ${document.activeLocalTabCount}`,
    );
  }
  if (!landmarks.some((landmark) => landmark.kind === "main")) {
    failures.push(`${prefix}: main landmark is missing`);
  }
  if (!landmarks.some((landmark) => landmark.kind === "tabpanel")) {
    failures.push(`${prefix}: active tab panel is missing`);
  }

  return failures;
}

function compareValue(expected, actual, path, tolerance, differences) {
  if (typeof expected === "number" && typeof actual === "number") {
    if (Math.abs(expected - actual) > tolerance) {
      differences.push(`${path}: expected ${expected}, got ${actual}`);
    }
    return;
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      differences.push(`${path}.length: expected ${expected.length}, got ${actual.length}`);
    }
    const length = Math.min(expected.length, actual.length);
    for (let index = 0; index < length; index += 1) {
      compareValue(expected[index], actual[index], `${path}[${index}]`, tolerance, differences);
    }
    return;
  }
  if (expected && actual && typeof expected === "object" && typeof actual === "object") {
    const expectedKeys = Object.keys(expected).sort();
    const actualKeys = Object.keys(actual).sort();
    for (const key of expectedKeys) {
      if (!(key in actual)) {
        differences.push(`${path}.${key}: missing`);
        continue;
      }
      compareValue(expected[key], actual[key], `${path}.${key}`, tolerance, differences);
    }
    for (const key of actualKeys) {
      if (!(key in expected)) differences.push(`${path}.${key}: unexpected`);
    }
    return;
  }
  if (expected !== actual) {
    differences.push(
      `${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

export function compareContracts(expected, actual, options = {}) {
  const tolerance = options.tolerance ?? 1;
  const differences = [];

  if (expected.version !== CONTRACT_VERSION) {
    differences.push(
      `baseline.version: expected contract version ${CONTRACT_VERSION}, got ${expected.version}`,
    );
  }
  if (actual.version !== CONTRACT_VERSION) {
    differences.push(
      `actual.version: expected contract version ${CONTRACT_VERSION}, got ${actual.version}`,
    );
  }

  // A focused run compares the entries it measured and deliberately ignores
  // unrelated entries in the complete checked-in baseline.
  for (const [key, actualEntry] of Object.entries(actual.entries)) {
    const expectedEntry = expected.entries[key];
    if (!expectedEntry) {
      differences.push(`entries.${key}: missing from baseline`);
      continue;
    }
    compareValue(expectedEntry, actualEntry, `entries.${key}`, tolerance, differences);
  }

  return differences;
}
