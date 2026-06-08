// SPDX-License-Identifier: Apache-2.0

/**
 * Shared org-binding form control for the consent screens (web OAuth consent
 * and the CLI device `/activate` consent). Rendered INSIDE the accept form so
 * `org_id` is submitted with the approval.
 *
 *   - Zero orgs → nothing (token resolves org per-request via `X-Org-Id`).
 *   - One org → a hidden input plus a context line (bound silently).
 *   - Many orgs → a labelled `<select>`.
 */

import { html, type RawHtml } from "./html.ts";
import type { ConsentOrgOption } from "../services/consent-org.ts";

export function renderOrgField(orgs: ConsentOrgOption[]): RawHtml | string {
  if (orgs.length === 0) return "";
  if (orgs.length === 1) {
    const only = orgs[0]!;
    return html`
      <input type="hidden" name="org_id" value="${only.id}" />
      <p class="org-single">Organisation : <strong>${only.name}</strong></p>
    `;
  }
  // The first org is selected by default (browsers select the first <option>).
  const options = orgs.map((o) => html`<option value="${o.id}">${o.name}</option>`);
  return html`
    <label class="org-label" for="org_id">Organisation</label>
    <select id="org_id" name="org_id" class="org-select">
      ${options}
    </select>
  `;
}
