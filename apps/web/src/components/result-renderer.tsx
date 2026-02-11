import { useMemo, useState } from "react";
import type { FlowOutputField } from "@appstrate/shared-types";
import { escapeHtml, convertMarkdown, truncate, formatDateField } from "../lib/markdown";

interface ResultRendererProps {
  data: Record<string, unknown>;
  outputSchema?: Record<string, FlowOutputField>;
}

function renderMetadata(data: Record<string, unknown>): string {
  const parts: string[] = [];
  if (data.emails_processed !== undefined) parts.push(`${data.emails_processed} mails traites`);
  if (data.emails_scanned !== undefined) parts.push(`${data.emails_scanned} mails scannes`);
  if (data.newsletters_found !== undefined)
    parts.push(`${data.newsletters_found} newsletters trouvees`);
  if (data.meetings_found !== undefined) parts.push(`${data.meetings_found} reunions trouvees`);
  if (data.meetings_prepped !== undefined)
    parts.push(`${data.meetings_prepped} reunions preparees`);
  if (data.meetings_skipped !== undefined) parts.push(`${data.meetings_skipped} ignorees`);
  if (data.ignored_count) parts.push(`${data.ignored_count} ignores`);
  if (data.tokensUsed) parts.push(`${data.tokensUsed} tokens`);
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
      html += `<li><strong>${escapeHtml(k)}:</strong> ${escapeHtml(String(v))}</li>`;
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
      html += `<li>${escapeHtml(item)}</li>`;
    } else if (typeof item === "object" && item !== null) {
      const obj = item as Record<string, unknown>;
      const display = (obj.name || obj.email || obj.title || "") as string;
      const extra = Object.entries(obj)
        .filter(([k]) => k !== "name" && k !== "email" && k !== "title")
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ");
      html += `<li>${display ? `<strong>${escapeHtml(display)}</strong>` : ""}${extra ? ` (${escapeHtml(truncate(extra, 100))})` : ""}</li>`;
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
          html += `<div class="result-item-meta"><strong>${escapeHtml(label)}:</strong> ${escapeHtml(strVal)}</div>`;
        }
      }
    }

    html += `</div>`;
  }

  html += `</div>`;
  return html;
}

function renderSchemaField(key: string, field: FlowOutputField, value: unknown): string {
  if (value === undefined || value === null) {
    return `<div class="result-item-meta"><strong>${escapeHtml(field.description)}:</strong> <em>—</em></div>`;
  }

  if (field.type === "string") {
    const strVal = String(value);
    if (strVal.length > 80) {
      return `<div class="result-item-content"><strong>${escapeHtml(field.description)}</strong><br>${convertMarkdown(strVal)}</div>`;
    }
    return `<div class="result-item-meta"><strong>${escapeHtml(field.description)}:</strong> ${escapeHtml(strVal)}</div>`;
  }

  if (field.type === "number") {
    return `<div class="result-item-meta"><strong>${escapeHtml(field.description)}:</strong> ${escapeHtml(String(value))}</div>`;
  }

  if (field.type === "boolean") {
    const label = value ? "Oui" : "Non";
    return `<div class="result-item-meta"><strong>${escapeHtml(field.description)}:</strong> <span class="relevance-badge ${value ? "high" : "low"}">${label}</span></div>`;
  }

  if (field.type === "array" && Array.isArray(value)) {
    if (value.length === 0) {
      return `<div class="result-item-meta"><strong>${escapeHtml(field.description)}:</strong> <em>Aucun</em></div>`;
    }
    if (typeof value[0] === "object" && value[0] !== null) {
      return renderGenericCards(key, value as Record<string, unknown>[]);
    }
    return renderNestedArray(field.description, value);
  }

  if (field.type === "object" && typeof value === "object" && !Array.isArray(value)) {
    return renderNestedObject(field.description, value as Record<string, unknown>);
  }

  return `<div class="result-item-meta"><strong>${escapeHtml(field.description)}:</strong> ${escapeHtml(String(value))}</div>`;
}

function buildSchemaResultHtml(
  data: Record<string, unknown>,
  schema: Record<string, FlowOutputField>,
): string {
  let html = `<h4>Resultat</h4>`;

  // Render summary first if present in schema
  if (schema.summary && data.summary) {
    html += `<div class="result-summary">${convertMarkdown(data.summary as string)}</div>`;
  }

  html += renderMetadata(data);

  // Render schema fields in declared order (skip summary already rendered above)
  for (const [key, field] of Object.entries(schema)) {
    if (key === "summary") continue;
    html += renderSchemaField(key, field, data[key]);
  }

  // Render extra fields not in schema (except internal fields)
  const schemaKeys = new Set(Object.keys(schema));
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
        html += `<div class="result-item-meta"><strong>${escapeHtml(label)}:</strong> ${escapeHtml(String(value))}</div>`;
      }
    }
  }

  return html;
}

function buildResultHtml(data: Record<string, unknown>): string {
  let html = `<h4>Resultat</h4>`;

  if (data.summary) {
    html += `<div class="result-summary">${convertMarkdown(data.summary as string)}</div>`;
  }

  html += renderMetadata(data);

  if (Array.isArray(data.tickets_created) && data.tickets_created.length > 0) {
    html += `<h4>Tickets crees</h4><ul class="ticket-list">`;
    for (const ticket of data.tickets_created as Record<string, string>[]) {
      html += `<li>
        ${ticket.url ? `<a href="${escapeHtml(ticket.url)}" target="_blank">${escapeHtml(ticket.title)}</a>` : escapeHtml(ticket.title)}
        ${ticket.priority ? ` — ${escapeHtml(ticket.priority)}` : ""}
      </li>`;
    }
    html += `</ul>`;
  }

  if (Array.isArray(data.informational) && data.informational.length > 0) {
    html += `<h4 style="margin-top: 0.75rem">Mails informatifs</h4><ul class="ticket-list">`;
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
  const [viewMode, setViewMode] = useState<"formatted" | "json">("formatted");

  const html = useMemo(
    () =>
      outputSchema && Object.keys(outputSchema).length > 0
        ? buildSchemaResultHtml(data, outputSchema)
        : buildResultHtml(data),
    [data, outputSchema],
  );

  const jsonString = useMemo(() => JSON.stringify(data, null, 2), [data]);

  return (
    <div className="result-section">
      <div className="result-view-toggle">
        <button
          className={`result-toggle-btn ${viewMode === "formatted" ? "active" : ""}`}
          onClick={() => setViewMode("formatted")}
        >
          Formaté
        </button>
        <button
          className={`result-toggle-btn ${viewMode === "json" ? "active" : ""}`}
          onClick={() => setViewMode("json")}
        >
          JSON
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
