// OpenFlows — Multi-page SPA Client (Coolify-style)

const API_BASE = "/api";
let currentFlowId = null;
let flowDetailCache = {};

// --- API Helpers ---

function getAuthHeaders() {
  const token = localStorage.getItem("openflows_token") || "";
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function apiFetch(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...getAuthHeaders(),
      ...options.headers,
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(err.message || `API Error: ${res.status}`);
  }
  return res.json();
}

async function api(path, options = {}) {
  return apiFetch(`${API_BASE}${path}`, options);
}

// --- WebSocket Manager ---

let wsConn = null;
const wsSubscriptions = new Map(); // channel → handler

function wsConnect() {
  const token = localStorage.getItem("openflows_token") || "";
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  wsConn = new WebSocket(`${proto}//${location.host}/ws?token=${encodeURIComponent(token)}`);

  wsConn.onopen = () => {
    // Re-subscribe on reconnect
    for (const [channel] of wsSubscriptions) {
      wsConn.send(JSON.stringify({ type: "subscribe", channel }));
    }
  };

  wsConn.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "pong") return;
    for (const [channel, handler] of wsSubscriptions) {
      if (matchChannel(channel, msg)) handler(msg);
    }
  };

  wsConn.onclose = () => {
    setTimeout(wsConnect, 2000);
  };
}

function matchChannel(channel, msg) {
  if (channel === "flows") {
    return msg.type === "execution_started" || msg.type === "execution_completed";
  }
  if (channel.startsWith("flow:")) {
    return (msg.type === "execution_started" || msg.type === "execution_completed") &&
           msg.flowId === channel.split(":")[1];
  }
  if (channel.startsWith("execution:")) {
    return msg.type === "log" && msg.executionId === channel.split(":")[1];
  }
  return false;
}

function wsSubscribe(channel, handler) {
  wsSubscriptions.set(channel, handler);
  if (wsConn?.readyState === WebSocket.OPEN) {
    wsConn.send(JSON.stringify({ type: "subscribe", channel }));
  }
}

function wsUnsubscribe(channel) {
  wsSubscriptions.delete(channel);
  if (wsConn?.readyState === WebSocket.OPEN) {
    wsConn.send(JSON.stringify({ type: "unsubscribe", channel }));
  }
}

function wsUnsubscribeAll() {
  for (const channel of [...wsSubscriptions.keys()]) {
    wsUnsubscribe(channel);
  }
}

// --- Markdown Converter ---

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function convertMarkdown(text) {
  if (!text) return "";
  let html = escapeHtml(text);
  html = html.replace(/^##### (.+)$/gm, "<h5>$1</h5>");
  html = html.replace(/^#### (.+)$/gm, "<h4>$1</h4>");
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => {
    if (/^https?:\/\/|^mailto:/i.test(url)) {
      return `<a href="${url}" target="_blank">${text}</a>`;
    }
    return text;
  });
  html = html.replace(/^(?:- |\* )(.+)$/gm, "<li>$1</li>");
  html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, "<ul>$1</ul>");
  html = html.replace(/\n\n/g, "</p><p>");
  html = html.replace(/\n/g, "<br>");
  if (!html.match(/^<(?:h[3-5]|ul|p)/)) {
    html = "<p>" + html + "</p>";
  }
  return html;
}

function truncate(str, max) {
  if (str.length <= max) return str;
  return str.slice(0, max) + "...";
}

// --- Router ---

function navigate(hash) {
  window.location.hash = hash;
}

function handleRoute() {
  wsUnsubscribeAll();

  const hash = window.location.hash || "#/";
  const app = document.getElementById("app");
  const breadcrumb = document.getElementById("breadcrumb");

  // Match routes
  let match;

  if ((match = hash.match(/^#\/flows\/([^/]+)\/executions\/([^/]+)$/))) {
    const [, flowId, execId] = match;
    updateNavActive("flows");
    breadcrumb.innerHTML = `
      <a onclick="navigate('#/')">Flows</a>
      <span class="separator">/</span>
      <a onclick="navigate('#/flows/${flowId}')">${flowDetailCache[flowId]?.displayName || flowId}</a>
      <span class="separator">/</span>
      <span class="current">${execId.slice(0, 16)}...</span>
    `;
    renderExecutionDetail(app, flowId, execId);
  } else if ((match = hash.match(/^#\/flows\/([^/]+)$/))) {
    const [, flowId] = match;
    updateNavActive("flows");
    breadcrumb.innerHTML = `
      <a onclick="navigate('#/')">Flows</a>
      <span class="separator">/</span>
      <span class="current">${flowDetailCache[flowId]?.displayName || flowId}</span>
    `;
    renderFlowDetail(app, flowId);
  } else if (hash === "#/services") {
    updateNavActive("services");
    breadcrumb.innerHTML = "";
    renderServicesList(app);
  } else {
    updateNavActive("flows");
    breadcrumb.innerHTML = "";
    renderFlowList(app);
  }
}

window.addEventListener("hashchange", handleRoute);

// --- View 1: Flow List ---

async function renderFlowList(container) {
  container.innerHTML = `<div class="empty-state"><span class="spinner"></span></div>`;

  try {
    const { flows } = await api("/flows");
    if (flows.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <p>Aucun flow disponible.</p>
          <p style="font-size: 0.8rem; margin-top: 0.5rem">Ajoutez un flow dans le repertoire <code>flows/</code></p>
        </div>
      `;
      return;
    }

    container.innerHTML = `<div class="flow-grid">${flows.map((flow) => `
      <div class="flow-card" onclick="navigate('#/flows/${flow.id}')">
        <div class="flow-card-header">
          <h2>${escapeHtml(flow.displayName)}</h2>
          ${flow.runningExecutions > 0 ? `<span class="running-badge"><span class="spinner"></span> ${flow.runningExecutions} en cours</span>` : ""}
        </div>
        <p class="description">${escapeHtml(flow.description)}</p>
        <div class="tags">
          ${(flow.tags || []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("")}
        </div>
      </div>
    `).join("")}</div>`;

    // Subscribe to live updates for flow list
    wsSubscribe("flows", () => {
      renderFlowList(document.getElementById("app"));
    });
  } catch (err) {
    container.innerHTML = `
      <div class="empty-state">
        <p>Impossible de charger les flows.</p>
        <p style="font-size: 0.8rem; margin-top: 0.5rem">${escapeHtml(err.message)}</p>
      </div>
    `;
  }
}

// --- View 2: Flow Detail ---

async function renderFlowDetail(container, flowId) {
  container.innerHTML = `<div class="empty-state"><span class="spinner"></span></div>`;

  try {
    const detail = await api(`/flows/${flowId}`);
    flowDetailCache[flowId] = detail;

    // Update breadcrumb with actual name
    const breadcrumb = document.getElementById("breadcrumb");
    breadcrumb.innerHTML = `
      <a onclick="navigate('#/')">Flows</a>
      <span class="separator">/</span>
      <span class="current">${escapeHtml(detail.displayName)}</span>
    `;

    const allConnected = detail.requires.services.every((s) => s.status === "connected");
    const hasRequiredConfig = checkRequiredConfig(detail);
    const hasInputSchema = detail.input?.schema && Object.keys(detail.input.schema).length > 0;
    const runAction = hasInputSchema ? `openInputModal('${flowId}')` : `runFlowFromDetail('${flowId}')`;

    container.innerHTML = `
      <div class="flow-detail-header">
        <h2>${escapeHtml(detail.displayName)}</h2>
        <p class="description">${escapeHtml(detail.description)}</p>
      </div>

      <div class="services">
        ${detail.requires.services.map((svc) => {
          const isConnected = svc.status === "connected";
          return `
            <span class="service ${isConnected ? "" : "not-connected"}"
                  ${!isConnected ? `onclick="connectService('${svc.provider}')"` : ""}
                  title="${escapeHtml(svc.description)}">
              <span class="status-dot ${isConnected ? "connected" : "disconnected"}"></span>
              ${escapeHtml(svc.id)}
              ${!isConnected ? " (connecter)" : ""}
            </span>
          `;
        }).join("")}
      </div>

      <div class="actions">
        <button onclick="openConfigModal('${flowId}')">Configurer</button>
        ${(() => {
          const hasState = detail.state && Object.keys(detail.state).length > 0;
          return hasState
            ? `<button onclick="openStateModal('${flowId}')">Etat</button>`
            : `<button disabled title="Aucun etat persiste">Etat (vide)</button>`;
        })()}
        <button class="primary"
                onclick="${runAction}"
                ${!allConnected || !hasRequiredConfig ? "disabled" : ""}
                title="${!allConnected ? "Connectez tous les services d'abord" : !hasRequiredConfig ? "Configurez les champs obligatoires" : "Lancer le flow"}">
          Lancer
        </button>
      </div>

      <div class="section-title">Executions</div>
      <div id="exec-list"></div>
    `;

    loadExecutionList(flowId);

    // Subscribe to live execution updates for this flow
    wsSubscribe(`flow:${flowId}`, () => {
      loadExecutionList(flowId);
    });
  } catch (err) {
    container.innerHTML = `
      <div class="empty-state">
        <p>Impossible de charger le flow.</p>
        <p style="font-size: 0.8rem; margin-top: 0.5rem">${escapeHtml(err.message)}</p>
      </div>
    `;
  }
}

async function loadExecutionList(flowId) {
  const listEl = document.getElementById("exec-list");
  if (!listEl) return;

  try {
    const { executions } = await api(`/flows/${flowId}/executions?limit=50`);

    if (!executions || executions.length === 0) {
      listEl.innerHTML = `<div class="empty-state" style="padding: 1.5rem"><p style="font-size: 0.8rem">Aucune execution</p></div>`;
      return;
    }

    listEl.innerHTML = `<div class="exec-list">${executions.map((exec) => {
      const date = new Date(exec.started_at).toLocaleString("fr-FR", {
        day: "2-digit", month: "2-digit", year: "numeric",
        hour: "2-digit", minute: "2-digit",
      });
      const duration = exec.duration ? `${(exec.duration / 1000).toFixed(1)}s` : "";
      const inputPreview = exec.input ? truncate(JSON.stringify(exec.input), 60) : "";
      const badgeClass = exec.status === "success" ? "badge-success" :
                         exec.status === "running" || exec.status === "pending" ? "badge-running" :
                         exec.status === "timeout" ? "badge-timeout" : "badge-failed";

      return `
        <div class="exec-row" onclick="navigate('#/flows/${flowId}/executions/${exec.id}')">
          <span class="badge ${badgeClass}">
            ${exec.status === "running" ? '<span class="spinner"></span>' : ""}
            ${exec.status}
          </span>
          <span class="exec-date">${date}</span>
          ${duration ? `<span class="exec-duration">${duration}</span>` : ""}
          ${inputPreview ? `<span class="exec-input-preview">${escapeHtml(inputPreview)}</span>` : ""}
        </div>
      `;
    }).join("")}</div>`;
  } catch {
    listEl.innerHTML = `<div class="empty-state" style="padding: 1rem"><p style="font-size: 0.8rem">Erreur de chargement</p></div>`;
  }
}

// --- Run flow from detail view ---

async function runFlowFromDetail(flowId, inputData) {
  try {
    const { executionId } = await api(`/flows/${flowId}/run`, {
      method: "POST",
      body: JSON.stringify({ stream: false, ...(inputData ? { input: inputData } : {}) }),
    });
    navigate(`#/flows/${flowId}/executions/${executionId}`);
  } catch (err) {
    alert(`Erreur : ${err.message}`);
  }
}

// --- Tab Switching ---

function switchTab(tabId) {
  document.querySelectorAll(".exec-tabs .tab").forEach(t => t.classList.remove("active"));
  document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
  document.querySelector(`.tab[onclick*="${tabId}"]`)?.classList.add("active");
  document.getElementById(`panel-${tabId}`)?.classList.add("active");
}

// --- View 3: Execution Detail ---

async function renderExecutionDetail(container, flowId, execId) {
  container.innerHTML = `<div class="empty-state"><span class="spinner"></span></div>`;

  try {
    const execution = await api(`/executions/${execId}`);
    const isRunning = execution.status === "running" || execution.status === "pending";
    const date = new Date(execution.started_at).toLocaleString("fr-FR", {
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    const duration = execution.duration ? `${(execution.duration / 1000).toFixed(1)}s` : "";
    const badgeClass = execution.status === "success" ? "badge-success" :
                       isRunning ? "badge-running" :
                       execution.status === "timeout" ? "badge-timeout" : "badge-failed";

    container.innerHTML = `
      <div class="exec-detail-header">
        <span class="badge ${badgeClass}" id="exec-badge">
          ${isRunning ? '<span class="spinner"></span>' : ""}
          ${execution.status}
        </span>
        <span class="exec-meta">${date}</span>
        ${duration ? `<span class="exec-meta">${duration}</span>` : ""}
        ${isRunning ? '<span class="live-indicator"><span class="spinner"></span> En direct</span>' : ""}
      </div>

      <div class="exec-tabs">
        <button class="tab active" onclick="switchTab('logs')">Logs <span id="log-count"></span></button>
        <button class="tab" onclick="switchTab('result')">Resultat</button>
      </div>

      <div class="tab-panel active" id="panel-logs">
        <div class="log-viewer">
          <div class="log-content" id="log-content"></div>
        </div>
      </div>

      <div class="tab-panel" id="panel-result">
        <div id="result-container">
          <div class="empty-state" style="padding: 1.5rem">
            <p style="font-size: 0.8rem">Aucun resultat</p>
          </div>
        </div>
      </div>
    `;

    if (isRunning) {
      // Load existing logs first (partial replay)
      await loadHistoricalLogs(execId);
      // Then subscribe for live updates via WebSocket
      wsSubscribe(`execution:${execId}`, (msg) => handleExecutionMessage(msg));
    } else {
      loadExecutionLogs(execId, execution);
    }
  } catch (err) {
    container.innerHTML = `
      <div class="empty-state">
        <p>Impossible de charger l'execution.</p>
        <p style="font-size: 0.8rem; margin-top: 0.5rem">${escapeHtml(err.message)}</p>
      </div>
    `;
  }
}

// Load historical logs (for replay before WS subscription)
async function loadHistoricalLogs(execId) {
  const logContent = document.getElementById("log-content");
  const logCount = document.getElementById("log-count");
  const resultContainer = document.getElementById("result-container");
  if (!logContent) return;

  try {
    const { logs } = await api(`/executions/${execId}/logs`);
    if (logCount) logCount.textContent = `${logs.length} events`;

    for (const log of logs) {
      if (log.event === "result" && log.data) {
        if (resultContainer) {
          resultContainer.innerHTML = `<div class="result-section" id="result-display"></div>`;
          renderResult(log.data, document.getElementById("result-display"));
        }
      } else if (log.event === "execution_completed") {
        // skip — shown as badge
      } else {
        const message = log.data?.message || log.message || formatEvent(log.event, log.data);
        if (message) appendLogEntry(logContent, message, log.type || "progress");
      }
    }
  } catch (err) {
    logContent.innerHTML = `<div class="log-entry error">Erreur de chargement des logs: ${escapeHtml(err.message)}</div>`;
  }
}

// Handle a live WS message for an execution
function handleExecutionMessage(msg) {
  const logContent = document.getElementById("log-content");
  const logCount = document.getElementById("log-count");
  const resultContainer = document.getElementById("result-container");
  if (!logContent) return;

  const event = msg.event;
  const data = msg.data || {};

  // Update event count
  const currentCount = parseInt(logCount?.textContent) || 0;
  if (logCount) logCount.textContent = `${currentCount + 1} events`;

  if (event === "result" && data) {
    if (resultContainer) {
      resultContainer.innerHTML = `<div class="result-section" id="result-display"></div>`;
      renderResult(data, document.getElementById("result-display"));
      switchTab("result");
    }
  } else if (event === "execution_completed") {
    // Update badge
    const badge = document.getElementById("exec-badge");
    const status = data.status || "failed";
    if (badge) {
      const badgeClass = status === "success" ? "badge-success" :
                         status === "timeout" ? "badge-timeout" : "badge-failed";
      badge.className = `badge ${badgeClass}`;
      badge.innerHTML = status;
    }
    // Remove live indicator
    const liveEl = document.querySelector(".live-indicator");
    if (liveEl) liveEl.remove();
  } else if (event === "progress") {
    appendLogEntry(logContent, data.message || "", "progress");
  } else {
    const message = data.message || formatEvent(event, data);
    if (message) appendLogEntry(logContent, message, "system");
  }
}

// Load historical logs for a finished execution
async function loadExecutionLogs(execId, execution) {
  const logContent = document.getElementById("log-content");
  const logCount = document.getElementById("log-count");
  const resultContainer = document.getElementById("result-container");
  if (!logContent) return;

  try {
    const { logs } = await api(`/executions/${execId}/logs`);
    logCount.textContent = `${logs.length} events`;

    let resultData = null;

    for (const log of logs) {
      if (log.event === "result" && log.data) {
        resultData = log.data;
      } else if (log.event === "execution_completed") {
        // skip — shown as badge
      } else {
        const message = log.data?.message || log.message || formatEvent(log.event, log.data);
        if (message) appendLogEntry(logContent, message, log.type || "progress");
      }
    }

    // Show result
    if (resultData && resultContainer) {
      resultContainer.innerHTML = `<div class="result-section" id="result-display"></div>`;
      renderResult(resultData, document.getElementById("result-display"));
      switchTab("result");
    } else if (execution.result && resultContainer) {
      resultContainer.innerHTML = `<div class="result-section" id="result-display"></div>`;
      renderResult(execution.result, document.getElementById("result-display"));
      switchTab("result");
    }
  } catch (err) {
    logContent.innerHTML = `<div class="log-entry error">Erreur de chargement des logs: ${escapeHtml(err.message)}</div>`;
  }
}

function formatEvent(event, data) {
  if (event === "execution_started") return `Execution demarree (${data?.executionId || ""})`;
  if (event === "dependency_check") {
    const checks = Object.entries(data?.services || {}).map(([k, v]) => `${k}: ${v}`).join(", ");
    return `Dependances verifiees — ${checks}`;
  }
  if (event === "adapter_started") return `Adapter ${data?.adapter || "unknown"} demarre`;
  return "";
}

function appendLogEntry(logEl, message, type) {
  if (!message) return;
  const entry = document.createElement("div");
  entry.className = `log-entry ${type}`;
  entry.textContent = message;
  logEl.appendChild(entry);
  logEl.scrollTop = logEl.scrollHeight;
}

// --- Result Rendering ---

function renderMetadata(data) {
  const parts = [];
  if (data.emails_processed !== undefined) parts.push(`${data.emails_processed} mails traites`);
  if (data.emails_scanned !== undefined) parts.push(`${data.emails_scanned} mails scannes`);
  if (data.newsletters_found !== undefined) parts.push(`${data.newsletters_found} newsletters trouvees`);
  if (data.meetings_found !== undefined) parts.push(`${data.meetings_found} reunions trouvees`);
  if (data.meetings_prepped !== undefined) parts.push(`${data.meetings_prepped} reunions preparees`);
  if (data.meetings_skipped !== undefined) parts.push(`${data.meetings_skipped} ignorees`);
  if (data.ignored_count) parts.push(`${data.ignored_count} ignores`);
  if (data.tokensUsed) parts.push(`${data.tokensUsed} tokens`);
  if (parts.length === 0) return "";
  return `<p class="result-metadata">${parts.join(" — ")}</p>`;
}

function renderResultItems(items) {
  if (!items || items.length === 0) return "";
  return `<div class="result-items">${items.map((item) => {
    const relevanceClass = item.relevance === "high" ? "high" : item.relevance === "medium" ? "medium" : "low";
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
  }).join("")}</div>`;
}

function renderResult(data, targetEl) {
  if (!targetEl) return;

  let html = `<h4>Resultat</h4>`;

  // Summary (common to all flows)
  if (data.summary) {
    html += `<div class="result-summary">${convertMarkdown(data.summary)}</div>`;
  }

  // Flow-specific metadata
  html += renderMetadata(data);

  // Render known array fields with specialized renderers
  if (data.tickets_created && data.tickets_created.length > 0) {
    html += `<h4>Tickets crees</h4><ul class="ticket-list">`;
    for (const ticket of data.tickets_created) {
      html += `<li>
        ${ticket.url ? `<a href="${escapeHtml(ticket.url)}" target="_blank">${escapeHtml(ticket.title)}</a>` : escapeHtml(ticket.title)}
        ${ticket.priority ? ` — ${escapeHtml(ticket.priority)}` : ""}
      </li>`;
    }
    html += `</ul>`;
  }

  if (data.informational && data.informational.length > 0) {
    html += `<h4 style="margin-top: 0.75rem">Mails informatifs</h4><ul class="ticket-list">`;
    for (const info of data.informational) {
      html += `<li><strong>${escapeHtml(info.from)}</strong>: ${escapeHtml(info.summary || info.subject)}</li>`;
    }
    html += `</ul>`;
  }

  if (data.results && data.results.length > 0) {
    html += renderResultItems(data.results);
  }

  // Generic renderer: any remaining array of objects gets rendered as cards
  const handledKeys = new Set(["summary", "tickets_created", "informational", "results", "emails_processed", "emails_scanned", "newsletters_found", "ignored_count", "tokensUsed", "state", "meetings_found", "meetings_prepped", "meetings_skipped"]);
  for (const [key, value] of Object.entries(data)) {
    if (handledKeys.has(key)) continue;
    if (Array.isArray(value) && value.length > 0 && typeof value[0] === "object") {
      html += renderGenericCards(key, value);
      handledKeys.add(key);
    }
  }

  targetEl.innerHTML = html;
}

// --- Generic card renderer for unknown result arrays ---

function renderGenericCards(sectionKey, items) {
  const title = sectionKey.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  let html = `<h4 style="margin-top: 0.75rem">${escapeHtml(title)}</h4>`;
  html += `<div class="result-items">`;

  for (const item of items) {
    html += `<div class="result-item">`;

    // Try to find a good title: title, name, subject, or first string field
    const itemTitle = item.title || item.name || item.subject || "";
    const subtitle = item.start ? formatDateField(item.start) : "";
    if (itemTitle) {
      html += `<div class="result-item-header"><strong>${escapeHtml(itemTitle)}</strong></div>`;
    }
    if (subtitle) {
      html += `<div class="result-item-meta"><span>${escapeHtml(subtitle)}</span>${item.end ? ` — ${escapeHtml(formatDateField(item.end))}` : ""}${item.location ? ` · ${escapeHtml(truncate(item.location, 50))}` : ""}</div>`;
    }

    // Render remaining fields
    const skipFields = new Set(["title", "name", "subject", "start", "end", "location", "event_id"]);
    for (const [k, v] of Object.entries(item)) {
      if (skipFields.has(k)) continue;
      if (v === null || v === undefined || v === "") continue;

      const label = k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

      if (typeof v === "object" && !Array.isArray(v)) {
        // Nested object (e.g. participants)
        html += renderNestedObject(label, v);
      } else if (Array.isArray(v)) {
        html += renderNestedArray(label, v);
      } else {
        // String or number value — render as markdown if it's long text
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

function renderNestedObject(label, obj) {
  let html = `<div class="result-item-content"><strong>${escapeHtml(label)}</strong>`;
  html += `<ul class="ticket-list">`;
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) {
      html += renderNestedArray(k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()), v);
    } else if (typeof v === "object") {
      html += `<li><strong>${escapeHtml(k)}:</strong> ${escapeHtml(JSON.stringify(v))}</li>`;
    } else {
      html += `<li><strong>${escapeHtml(k)}:</strong> ${escapeHtml(String(v))}</li>`;
    }
  }
  html += `</ul></div>`;
  return html;
}

function renderNestedArray(label, arr) {
  if (arr.length === 0) return "";
  let html = `<div class="result-item-content"><strong>${escapeHtml(label)}</strong><ul class="ticket-list">`;
  for (const item of arr) {
    if (typeof item === "string") {
      html += `<li>${escapeHtml(item)}</li>`;
    } else if (typeof item === "object" && item !== null) {
      // Compact object display: name/email or first few fields
      const display = item.name || item.email || item.title || "";
      const extra = Object.entries(item)
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

function formatDateField(dateStr) {
  try {
    return new Date(dateStr).toLocaleString("fr-FR", {
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return dateStr;
  }
}

// --- Config Modal ---

function checkRequiredConfig(detail) {
  const schema = detail.config?.schema || {};
  const current = detail.config?.current || {};
  for (const [key, field] of Object.entries(schema)) {
    if (field.required && (current[key] === undefined || current[key] === null || current[key] === "")) {
      return false;
    }
  }
  return true;
}

function openConfigModal(flowId) {
  currentFlowId = flowId;
  const detail = flowDetailCache[flowId];
  if (!detail) return;

  document.getElementById("configModalTitle").textContent = `Configuration — ${detail.displayName}`;

  const schema = detail.config?.schema || {};
  const current = detail.config?.current || {};

  const formHtml = Object.entries(schema)
    .map(([key, field]) => {
      const value = current[key] ?? field.default ?? "";
      const required = field.required ? " *" : "";

      if (field.enum) {
        return `
        <div class="form-group">
          <label>${escapeHtml(key)}${required}</label>
          <select id="config-${key}" data-key="${key}">
            ${field.enum.map((v) => `<option value="${v}" ${v === value ? "selected" : ""}>${v}</option>`).join("")}
          </select>
          <div class="hint">${escapeHtml(field.description)}</div>
        </div>
      `;
      }

      return `
      <div class="form-group">
        <label>${escapeHtml(key)}${required}</label>
        <input type="${field.type === "number" ? "number" : "text"}"
               id="config-${key}"
               data-key="${key}"
               value="${value || ""}"
               placeholder="${escapeHtml(field.description)}">
        <div class="hint">${escapeHtml(field.description)}</div>
      </div>
    `;
    })
    .join("");

  document.getElementById("configForm").innerHTML = formHtml;
  document.getElementById("configModal").classList.add("active");
}

function closeConfigModal() {
  document.getElementById("configModal").classList.remove("active");
  currentFlowId = null;
}

async function saveConfig() {
  if (!currentFlowId) return;

  const detail = flowDetailCache[currentFlowId];
  const schema = detail.config?.schema || {};
  const config = {};

  for (const key of Object.keys(schema)) {
    const el = document.getElementById(`config-${key}`);
    if (!el) continue;
    let value = el.value;
    if (schema[key].type === "number" && value) value = Number(value);
    config[key] = value || null;
  }

  try {
    await api(`/flows/${currentFlowId}/config`, {
      method: "PUT",
      body: JSON.stringify(config),
    });

    const flowId = currentFlowId;
    closeConfigModal();
    // Reload the flow detail view
    navigate(`#/flows/${flowId}`);
  } catch (err) {
    alert(`Erreur : ${err.message}`);
  }
}

// --- State Modal ---

function openStateModal(flowId) {
  currentFlowId = flowId;
  const detail = flowDetailCache[flowId];
  if (!detail) return;

  document.getElementById("stateModalTitle").textContent = `Etat — ${detail.displayName}`;
  document.getElementById("stateContent").innerHTML =
    `<pre class="state-json">${escapeHtml(JSON.stringify(detail.state, null, 2))}</pre>`;
  document.getElementById("stateModal").classList.add("active");
}

function closeStateModal() {
  document.getElementById("stateModal").classList.remove("active");
  currentFlowId = null;
}

async function resetState() {
  if (!currentFlowId) return;
  if (!confirm("Reinitialiser l'etat du flow ? Cette action est irreversible.")) return;

  const flowId = currentFlowId;
  try {
    await fetch(`${API_BASE}/flows/${flowId}/state`, {
      method: "DELETE",
      headers: getAuthHeaders(),
    });
    closeStateModal();
    navigate(`#/flows/${flowId}`);
  } catch (err) {
    alert(`Erreur : ${err.message}`);
  }
}

// --- Connect Service ---

async function connectService(provider) {
  try {
    const session = await apiFetch(`/auth/connect/${provider}`, { method: "POST" });
    const popup = window.open(session.connectLink, "oauth", "width=600,height=700");

    const interval = setInterval(() => {
      if (popup && popup.closed) {
        clearInterval(interval);
        handleRoute();
      }
    }, 500);
  } catch (err) {
    alert(`Erreur de connexion : ${err.message}`);
  }
}

// --- Input Modal ---

function openInputModal(flowId) {
  currentFlowId = flowId;
  const detail = flowDetailCache[flowId];
  if (!detail) return;

  document.getElementById("inputModalTitle").textContent = `${detail.displayName} — Parametres`;

  const schema = detail.input?.schema || {};

  const formHtml = Object.entries(schema)
    .map(([key, field]) => {
      const value = field.default ?? "";
      const required = field.required ? " *" : "";

      return `
      <div class="form-group">
        <label>${escapeHtml(key)}${required}</label>
        <input type="${field.type === "number" ? "number" : "text"}"
               id="input-${key}"
               data-key="${key}"
               value="${value || ""}"
               placeholder="${escapeHtml(field.placeholder || field.description)}">
        <div class="hint">${escapeHtml(field.description)}</div>
      </div>
    `;
    })
    .join("");

  document.getElementById("inputForm").innerHTML = formHtml;
  document.getElementById("inputModal").classList.add("active");
}

function closeInputModal() {
  document.getElementById("inputModal").classList.remove("active");
  currentFlowId = null;
}

function submitInput() {
  if (!currentFlowId) return;

  const detail = flowDetailCache[currentFlowId];
  const schema = detail.input?.schema || {};
  const input = {};

  for (const [key, field] of Object.entries(schema)) {
    const el = document.getElementById(`input-${key}`);
    if (!el) continue;
    let value = el.value;
    if (field.type === "number" && value) value = Number(value);
    input[key] = value || null;
  }

  // Validate required fields
  for (const [key, field] of Object.entries(schema)) {
    if (field.required && (!input[key] || input[key] === "")) {
      alert(`Le champ "${key}" est requis`);
      return;
    }
  }

  const flowId = currentFlowId;
  closeInputModal();
  runFlowFromDetail(flowId, input);
}

// --- Navigation ---

function updateNavActive(tab) {
  const nav = document.getElementById("mainNav");
  if (!nav) return;
  nav.querySelectorAll(".nav-tab").forEach((t) => t.classList.remove("active"));
  const tabs = nav.querySelectorAll(".nav-tab");
  if (tab === "services" && tabs[1]) tabs[1].classList.add("active");
  else if (tabs[0]) tabs[0].classList.add("active");
}

// --- View: Services List ---

async function renderServicesList(container) {
  container.innerHTML = `<div class="empty-state"><span class="spinner"></span></div>`;

  try {
    const { integrations } = await apiFetch("/auth/integrations");

    if (!integrations || integrations.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <p>Aucun service configure.</p>
          <p style="font-size: 0.8rem; margin-top: 0.5rem">Configurez des integrations dans Nango pour les voir ici.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = `
      <div class="section-title">Services</div>
      <div class="services-grid">${integrations.map((svc) => {
        const isConnected = svc.status === "connected";
        const connDate = svc.connectedAt
          ? new Date(svc.connectedAt).toLocaleString("fr-FR", {
              day: "2-digit", month: "2-digit", year: "numeric",
              hour: "2-digit", minute: "2-digit",
            })
          : "";

        return `
          <div class="service-card">
            <div class="service-card-header">
              ${svc.logo ? `<img class="service-logo" src="${escapeHtml(svc.logo)}" alt="${escapeHtml(svc.displayName)}">` : ""}
              <div class="service-info">
                <h3>${escapeHtml(svc.displayName)}</h3>
                <span class="service-provider">${escapeHtml(svc.provider)}</span>
              </div>
            </div>
            <div class="service-card-status">
              <span class="status-dot ${isConnected ? "connected" : "disconnected"}"></span>
              <span class="badge ${isConnected ? "badge-success" : "badge-failed"}">${isConnected ? "Connecte" : "Non connecte"}</span>
              ${connDate ? `<span class="service-date">${connDate}</span>` : ""}
            </div>
            <div class="service-card-actions">
              ${isConnected
                ? `<button onclick="disconnectService('${escapeHtml(svc.uniqueKey)}')">Deconnecter</button>
                   <button onclick="connectService('${escapeHtml(svc.uniqueKey)}')">Reconnecter</button>`
                : `<button class="primary" onclick="connectService('${escapeHtml(svc.uniqueKey)}')">Connecter</button>`
              }
            </div>
          </div>
        `;
      }).join("")}</div>
    `;
  } catch (err) {
    container.innerHTML = `
      <div class="empty-state">
        <p>Impossible de charger les services.</p>
        <p style="font-size: 0.8rem; margin-top: 0.5rem">${escapeHtml(err.message)}</p>
      </div>
    `;
  }
}

async function disconnectService(provider) {
  if (!confirm(`Deconnecter le service "${provider}" ?`)) return;
  try {
    await apiFetch(`/auth/connections/${provider}`, { method: "DELETE" });
    handleRoute();
  } catch (err) {
    alert(`Erreur : ${err.message}`);
  }
}

// --- Modal event listeners ---

document.getElementById("configModal").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) closeConfigModal();
});
document.getElementById("inputModal").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) closeInputModal();
});
document.getElementById("stateModal").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) closeStateModal();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeConfigModal();
    closeInputModal();
    closeStateModal();
  }
});

// --- Init ---

wsConnect();

if (!window.location.hash || window.location.hash === "#") {
  window.location.hash = "#/";
}
handleRoute();
