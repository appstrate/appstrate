import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { JSONSchemaObject, JSONSchemaProperty } from "@appstrate/shared-types";
import {
  escapeHtml,
  linkifyText,
  convertMarkdown,
  truncate,
  formatDateField,
} from "../lib/markdown";

interface ResultRendererProps {
  data: Record<string, unknown>;
  outputSchema?: JSONSchemaObject;
}

function renderMetadata(
  data: Record<string, unknown>,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const parts: string[] = [];
  if (data.emails_processed !== undefined)
    parts.push(t("result.emailsProcessed", { count: data.emails_processed }));
  if (data.emails_scanned !== undefined)
    parts.push(t("result.emailsScanned", { count: data.emails_scanned }));
  if (data.newsletters_found !== undefined)
    parts.push(t("result.newslettersFound", { count: data.newsletters_found }));
  if (data.meetings_found !== undefined)
    parts.push(t("result.meetingsFound", { count: data.meetings_found }));
  if (data.meetings_prepped !== undefined)
    parts.push(t("result.meetingsPrepped", { count: data.meetings_prepped }));
  if (data.meetings_skipped !== undefined)
    parts.push(t("result.meetingsSkipped", { count: data.meetings_skipped }));
  if (data.ignored_count) parts.push(t("result.ignoredCount", { count: data.ignored_count }));
  if (parts.length === 0) return "";
  return `<p class="result-metadata">${parts.join(" — ")}</p>`;
}

interface ResultItem {
  newsletter?: string;
  relevance?: string;
  subject?: string;
  from?: string;
  date?: string;
  relevant_content?: string;
}

function renderResultItems(items: ResultItem[]): string {
  if (!items || items.length === 0) return "";
  return `<div class="result-items">${items
    .map((item) => {
      const relevanceClass =
        item.relevance === "high" ? "high" : item.relevance === "medium" ? "medium" : "low";
      return `
      <div class="result-item">
        <div class="result-item-header">
          ${item.newsletter ? `<span class="result-item-source">${escapeHtml(item.newsletter)}</span>` : ""}
          ${item.relevance ? `<span class="relevance-badge ${relevanceClass}">${item.relevance}</span>` : ""}
        </div>
        ${item.subject ? `<div class="result-item-subject">${escapeHtml(item.subject)}</div>` : ""}
        <div class="result-item-meta">
          ${item.from ? `<span>${escapeHtml(item.from)}</span>` : ""}
          ${item.date ? `<span>${escapeHtml(item.date)}</span>` : ""}
        </div>
        ${item.relevant_content ? `<div class="result-item-content">${convertMarkdown(item.relevant_content)}</div>` : ""}
      </div>
    `;
    })
    .join("")}</div>`;
}

function renderNestedObject(label: string, obj: Record<string, unknown>): string {
  let html = `<div class="result-item-content"><strong>${escapeHtml(label)}</strong>`;
  html += `<ul class="ticket-list">`;
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) {
      html += renderNestedArray(
        k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
        v,
      );
    } else if (typeof v === "object") {
      html += `<li><strong>${escapeHtml(k)}:</strong> ${escapeHtml(JSON.stringify(v))}</li>`;
    } else {
      html += `<li><strong>${escapeHtml(k)}:</strong> ${linkifyText(String(v))}</li>`;
    }
  }
  html += `</ul></div>`;
  return html;
}

function renderNestedArray(label: string, arr: unknown[]): string {
  if (arr.length === 0) return "";
  let html = `<div class="result-item-content"><strong>${escapeHtml(label)}</strong><ul class="ticket-list">`;
  for (const item of arr) {
    if (typeof item === "string") {
      html += `<li>${linkifyText(item)}</li>`;
    } else if (typeof item === "object" && item !== null) {
      const obj = item as Record<string, unknown>;
      const display = (obj.name || obj.email || obj.title || "") as string;
      const extra = Object.entries(obj)
        .filter(([k]) => k !== "name" && k !== "email" && k !== "title")
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ");
      html += `<li>${display ? `<strong>${escapeHtml(display)}</strong>` : ""}${extra ? ` (${linkifyText(truncate(extra, 100))})` : ""}</li>`;
    } else {
      html += `<li>${escapeHtml(String(item))}</li>`;
    }
  }
  html += `</ul></div>`;
  return html;
}

function renderGenericCards(sectionKey: string, items: Record<string, unknown>[]): string {
  const title = sectionKey.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  let html = `<h4>${escapeHtml(title)}</h4>`;
  html += `<div class="result-items">`;

  for (const item of items) {
    html += `<div class="result-item">`;

    const itemTitle = (item.title || item.name || item.subject || "") as string;
    const subtitle = item.start ? formatDateField(item.start as string) : "";
    if (itemTitle) {
      html += `<div class="result-item-header"><strong>${escapeHtml(itemTitle)}</strong></div>`;
    }
    if (subtitle) {
      html += `<div class="result-item-meta"><span>${escapeHtml(subtitle)}</span>${item.end ? ` — ${escapeHtml(formatDateField(item.end as string))}` : ""}${item.location ? ` · ${escapeHtml(truncate(item.location as string, 50))}` : ""}</div>`;
    }

    const skipFields = new Set([
      "title",
      "name",
      "subject",
      "start",
      "end",
      "location",
      "event_id",
    ]);
    for (const [k, v] of Object.entries(item)) {
      if (skipFields.has(k)) continue;
      if (v === null || v === undefined || v === "") continue;

      const label = k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

      if (typeof v === "object" && !Array.isArray(v)) {
        html += renderNestedObject(label, v as Record<string, unknown>);
      } else if (Array.isArray(v)) {
        html += renderNestedArray(label, v);
      } else {
        const strVal = String(v);
        if (strVal.length > 80) {
          html += `<div class="result-item-content"><strong>${escapeHtml(label)}</strong><br>${convertMarkdown(strVal)}</div>`;
        } else {
          html += `<div class="result-item-meta"><strong>${escapeHtml(label)}:</strong> ${linkifyText(strVal)}</div>`;
        }
      }
    }

    html += `</div>`;
  }

  html += `</div>`;
  return html;
}

function renderSchemaField(
  key: string,
  prop: JSONSchemaProperty,
  value: unknown,
  t: (key: string) => string,
): string {
  const desc = prop.description || key;
  if (value === undefined || value === null) {
    return `<div class="result-item-meta"><strong>${escapeHtml(desc)}:</strong> <em>—</em></div>`;
  }

  if (prop.type === "string") {
    const strVal = String(value);
    if (strVal.length > 80) {
      return `<div class="result-item-content"><strong>${escapeHtml(desc)}</strong><br>${convertMarkdown(strVal)}</div>`;
    }
    return `<div class="result-item-meta"><strong>${escapeHtml(desc)}:</strong> ${linkifyText(strVal)}</div>`;
  }

  if (prop.type === "number") {
    return `<div class="result-item-meta"><strong>${escapeHtml(desc)}:</strong> ${escapeHtml(String(value))}</div>`;
  }

  if (prop.type === "boolean") {
    const label = value ? t("result.boolYes") : t("result.boolNo");
    return `<div class="result-item-meta"><strong>${escapeHtml(desc)}:</strong> <span class="relevance-badge ${value ? "high" : "low"}">${label}</span></div>`;
  }

  if (prop.type === "array" && Array.isArray(value)) {
    if (value.length === 0) {
      return `<div class="result-item-meta"><strong>${escapeHtml(desc)}:</strong> <em>${t("result.emptyArray")}</em></div>`;
    }
    if (typeof value[0] === "object" && value[0] !== null) {
      return renderGenericCards(key, value as Record<string, unknown>[]);
    }
    return renderNestedArray(desc, value);
  }

  if (prop.type === "object" && typeof value === "object" && !Array.isArray(value)) {
    return renderNestedObject(desc, value as Record<string, unknown>);
  }

  return `<div class="result-item-meta"><strong>${escapeHtml(desc)}:</strong> ${linkifyText(String(value))}</div>`;
}

function buildSchemaResultHtml(
  data: Record<string, unknown>,
  schema: JSONSchemaObject,
  t: (key: string) => string,
): string {
  let html = `<h4>${t("result.title")}</h4>`;

  // Render summary first if present in schema
  if (schema.properties.summary && data.summary) {
    html += `<div class="result-summary">${convertMarkdown(data.summary as string)}</div>`;
  }

  html += renderMetadata(data, t);

  // Render schema fields in declared order (skip summary already rendered above)
  for (const [key, prop] of Object.entries(schema.properties)) {
    if (key === "summary") continue;
    html += renderSchemaField(key, prop, data[key], t);
  }

  // Render extra fields not in schema (except internal fields)
  const schemaKeys = new Set(Object.keys(schema.properties));
  const internalKeys = new Set(["state", "tokensUsed"]);
  const metadataKeys = new Set([
    "emails_processed",
    "emails_scanned",
    "newsletters_found",
    "meetings_found",
    "meetings_prepped",
    "meetings_skipped",
    "ignored_count",
  ]);
  const extraEntries = Object.entries(data).filter(
    ([k]) => !schemaKeys.has(k) && !internalKeys.has(k) && !metadataKeys.has(k),
  );

  if (extraEntries.length > 0) {
    for (const [key, value] of extraEntries) {
      if (value === null || value === undefined) continue;
      const label = key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      if (Array.isArray(value) && value.length > 0 && typeof value[0] === "object") {
        html += renderGenericCards(key, value as Record<string, unknown>[]);
      } else if (typeof value === "object" && !Array.isArray(value)) {
        html += renderNestedObject(label, value as Record<string, unknown>);
      } else {
        html += `<div class="result-item-meta"><strong>${escapeHtml(label)}:</strong> ${linkifyText(String(value))}</div>`;
      }
    }
  }

  return html;
}

function buildResultHtml(data: Record<string, unknown>, t: (key: string) => string): string {
  let html = `<h4>${t("result.title")}</h4>`;

  if (data.summary) {
    html += `<div class="result-summary">${convertMarkdown(data.summary as string)}</div>`;
  }

  html += renderMetadata(data, t);

  if (Array.isArray(data.tickets_created) && data.tickets_created.length > 0) {
    html += `<h4>${t("result.ticketsCreated")}</h4><ul class="ticket-list">`;
    for (const ticket of data.tickets_created as Record<string, string>[]) {
      html += `<li>
        ${ticket.url ? `<a href="${escapeHtml(ticket.url)}" target="_blank">${escapeHtml(ticket.title)}</a>` : escapeHtml(ticket.title)}
        ${ticket.priority ? ` — ${escapeHtml(ticket.priority)}` : ""}
      </li>`;
    }
    html += `</ul>`;
  }

  if (Array.isArray(data.informational) && data.informational.length > 0) {
    html += `<h4 style="margin-top: 0.75rem">${t("result.informational")}</h4><ul class="ticket-list">`;
    for (const info of data.informational as Record<string, string>[]) {
      html += `<li><strong>${escapeHtml(info.from)}</strong>: ${escapeHtml(info.summary || info.subject)}</li>`;
    }
    html += `</ul>`;
  }

  if (Array.isArray(data.results) && data.results.length > 0) {
    html += renderResultItems(data.results as ResultItem[]);
  }

  const handledKeys = new Set([
    "summary",
    "tickets_created",
    "informational",
    "results",
    "emails_processed",
    "emails_scanned",
    "newsletters_found",
    "ignored_count",
    "tokensUsed",
    "state",
    "meetings_found",
    "meetings_prepped",
    "meetings_skipped",
  ]);
  for (const [key, value] of Object.entries(data)) {
    if (handledKeys.has(key)) continue;
    if (Array.isArray(value) && value.length > 0 && typeof value[0] === "object") {
      html += renderGenericCards(key, value as Record<string, unknown>[]);
      handledKeys.add(key);
    }
  }

  return html;
}

export function ResultRenderer({ data, outputSchema }: ResultRendererProps) {
  const { t } = useTranslation(["flows", "common"]);
  const [viewMode, setViewMode] = useState<"formatted" | "json">("formatted");

  const html = useMemo(
    () =>
      outputSchema?.properties && Object.keys(outputSchema.properties).length > 0
        ? buildSchemaResultHtml(data, outputSchema, t)
        : buildResultHtml(data, t),
    [data, outputSchema, t],
  );

  const jsonString = useMemo(() => JSON.stringify(data, null, 2), [data]);

  return (
    <div className="result-section">
      <div className="result-view-toggle">
        <button
          className={`result-toggle-btn ${viewMode === "formatted" ? "active" : ""}`}
          onClick={() => setViewMode("formatted")}
        >
          {t("result.formatted")}
        </button>
        <button
          className={`result-toggle-btn ${viewMode === "json" ? "active" : ""}`}
          onClick={() => setViewMode("json")}
        >
          {t("result.json")}
        </button>
      </div>
      {viewMode === "formatted" ? (
        <div dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="result-json-viewer">{jsonString}</pre>
      )}
    </div>
  );
}
