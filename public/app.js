// OpenFlows — Multi-page SPA Client (Coolify-style)

const API_BASE = "/api";
let currentFlowId = null;
let flowDetailCache = {};
let activeAbortController = null;
let execListInterval = null;

// --- API Helpers ---

function getAuthHeaders() {
  const token = localStorage.getItem("openflows_token") || "";
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function api(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
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
  // Cleanup previous view
  cleanupActiveStream();
  clearInterval(execListInterval);
  execListInterval = null;

  const hash = window.location.hash || "#/";
  const app = document.getElementById("app");
  const breadcrumb = document.getElementById("breadcrumb");

  // Match routes
  let match;

  if ((match = hash.match(/^#\/flows\/([^/]+)\/executions\/([^/]+)$/))) {
    const [, flowId, execId] = match;
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
    breadcrumb.innerHTML = `
      <a onclick="navigate('#/')">Flows</a>
      <span class="separator">/</span>
      <span class="current">${flowDetailCache[flowId]?.displayName || flowId}</span>
    `;
    renderFlowDetail(app, flowId);
  } else {
    breadcrumb.innerHTML = "";
    renderFlowList(app);
  }
}

window.addEventListener("hashchange", handleRoute);

// --- Cleanup ---

function cleanupActiveStream() {
  if (activeAbortController) {
    activeAbortController.abort();
    activeAbortController = null;
  }
}

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

    // Poll execution list if there are running executions
    startExecListPolling(flowId);
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

function startExecListPolling(flowId) {
  clearInterval(execListInterval);
  execListInterval = setInterval(async () => {
    // Only poll if we're still on this flow's detail view
    const hash = window.location.hash || "#/";
    if (hash !== `#/flows/${flowId}`) {
      clearInterval(execListInterval);
      execListInterval = null;
      return;
    }
    await loadExecutionList(flowId);
  }, 5000);
}

// --- Run flow from detail view ---

async function runFlowFromDetail(flowId, inputData) {
  try {
    const abortController = new AbortController();
    const res = await fetch(`${API_BASE}/flows/${flowId}/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...getAuthHeaders(),
      },
      body: JSON.stringify({ stream: true, ...(inputData ? { input: inputData } : {}) }),
      signal: abortController.signal,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(err.message || `Error: ${res.status}`);
    }

    // Read the first SSE event to get executionId
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let executionId = null;

    while (!executionId) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      let eventType = null;
      for (const line of lines) {
        if (line.startsWith("event: ")) {
          eventType = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.executionId) {
              executionId = data.executionId;
            }
          } catch {}
          eventType = null;
        }
      }
    }

    // Cancel the SSE reader — execution continues in background
    abortController.abort();

    if (executionId) {
      navigate(`#/flows/${flowId}/executions/${executionId}`);
    } else {
      // Fallback: reload execution list
      navigate(`#/flows/${flowId}`);
    }
  } catch (err) {
    if (err.name === "AbortError") return;
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
      streamExecutionLogs(execId);
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

// Stream live logs for a running execution
async function streamExecutionLogs(execId) {
  const logContent = document.getElementById("log-content");
  const logCount = document.getElementById("log-count");
  const resultContainer = document.getElementById("result-container");
  if (!logContent) return;

  const abortController = new AbortController();
  activeAbortController = abortController;
  let eventCount = 0;

  try {
    const res = await fetch(`${API_BASE}/executions/${execId}/stream`, {
      headers: { ...getAuthHeaders() },
      signal: abortController.signal,
    });

    if (!res.ok) throw new Error(`Stream error: ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      let eventType = null;

      for (const line of lines) {
        if (line.startsWith("event: ")) {
          eventType = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
          try {
            const data = JSON.parse(line.slice(6));
            eventCount++;
            if (logCount) logCount.textContent = `${eventCount} events`;

            if (eventType === "result" && data) {
              if (resultContainer) {
                resultContainer.innerHTML = `<div class="result-section" id="result-display"></div>`;
                renderResult(data, document.getElementById("result-display"));
                switchTab("result");
              }
            } else if (eventType === "execution_completed") {
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
            } else if (eventType === "progress") {
              appendLogEntry(logContent, data.message || "", "progress");
            } else {
              const message = data.message || formatEvent(eventType, data);
              if (message) appendLogEntry(logContent, message, "system");
            }
          } catch {}
          eventType = null;
        }
      }
    }
  } catch (err) {
    if (err.name === "AbortError") return;
    appendLogEntry(logContent, `Stream interrompu: ${err.message}`, "error");
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

  if (data.summary) {
    html += `<div class="result-summary">${convertMarkdown(data.summary)}</div>`;
  }

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

  html += renderMetadata(data);

  const knownKeys = ["summary", "tickets_created", "informational", "results", "emails_processed", "emails_scanned", "newsletters_found", "ignored_count", "tokensUsed", "state"];
  const hasKnownField = Object.keys(data).some((k) => knownKeys.includes(k));
  if (!hasKnownField) {
    html += `<pre style="font-size: 0.75rem; overflow-x: auto; white-space: pre-wrap; color: var(--text-muted)">${escapeHtml(JSON.stringify(data, null, 2))}</pre>`;
  }

  targetEl.innerHTML = html;
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

// --- Connect Service ---

async function connectService(provider) {
  try {
    const res = await fetch(`/auth/connect/${provider}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...getAuthHeaders(),
      },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(err.message || `Error: ${res.status}`);
    }
    const session = await res.json();

    const popup = window.open(session.connectLink, "oauth", "width=600,height=700");

    const interval = setInterval(() => {
      if (popup && popup.closed) {
        clearInterval(interval);
        // Reload current view
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

// --- Modal event listeners ---

document.getElementById("configModal").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) closeConfigModal();
});
document.getElementById("inputModal").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) closeInputModal();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeConfigModal();
    closeInputModal();
  }
});

// --- Init ---

if (!window.location.hash || window.location.hash === "#") {
  window.location.hash = "#/";
}
handleRoute();
