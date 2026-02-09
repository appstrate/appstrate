// OpenFlows — Minimal SPA Client

const API_BASE = "/api";
let currentFlowId = null;
let flowsData = {};
let pendingResults = {}; // Cache SSE result data for history auto-expand

// --- API Helpers ---

async function api(path, options = {}) {
  const token = localStorage.getItem("openflows_token") || "";
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(err.message || `API Error: ${res.status}`);
  }
  return res.json();
}

// --- Markdown Converter (inline, vanilla JS) ---

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

  // Headers: ### h3, #### h4, ##### h5
  html = html.replace(/^##### (.+)$/gm, "<h5>$1</h5>");
  html = html.replace(/^#### (.+)$/gm, "<h4>$1</h4>");
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");

  // Bold: **text**
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

  // Italic: *text*
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");

  // Links: [text](url) — only allow http(s) and mailto protocols
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => {
    if (/^https?:\/\/|^mailto:/i.test(url)) {
      return `<a href="${url}" target="_blank">${text}</a>`;
    }
    return text;
  });

  // Unordered lists: lines starting with - or *
  html = html.replace(/^(?:- |\* )(.+)$/gm, "<li>$1</li>");
  html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, "<ul>$1</ul>");

  // Line breaks: double newline → paragraph break, single → <br>
  html = html.replace(/\n\n/g, "</p><p>");
  html = html.replace(/\n/g, "<br>");

  // Wrap in paragraph if not starting with block element
  if (!html.match(/^<(?:h[3-5]|ul|p)/)) {
    html = "<p>" + html + "</p>";
  }

  return html;
}

// --- Init ---

async function init() {
  try {
    const { flows } = await api("/flows");
    renderFlows(flows);

    // Load details for each flow
    for (const flow of flows) {
      const detail = await api(`/flows/${flow.id}`);
      flowsData[flow.id] = detail;
      renderFlowDetail(flow.id, detail);
    }
  } catch (err) {
    document.getElementById("flowsList").innerHTML = `
      <div class="empty-state">
        <p>Impossible de charger les flows.</p>
        <p style="font-size: 0.8rem; margin-top: 0.5rem">${err.message}</p>
      </div>
    `;
  }
}

// --- Render ---

function renderFlows(flows) {
  const container = document.getElementById("flowsList");

  if (flows.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <p>Aucun flow disponible.</p>
        <p style="font-size: 0.8rem; margin-top: 0.5rem">Ajoutez un flow dans le répertoire <code>flows/</code></p>
      </div>
    `;
    return;
  }

  container.innerHTML = flows
    .map(
      (flow) => `
    <div class="flow-card" id="flow-${flow.id}">
      <h2>${flow.displayName}</h2>
      <p class="description">${flow.description}</p>
      <div class="tags">
        ${(flow.tags || []).map((t) => `<span class="tag">${t}</span>`).join("")}
      </div>
      <div class="services" id="services-${flow.id}">
        <span class="badge">Chargement...</span>
      </div>
      <div class="actions" id="actions-${flow.id}">
        <button disabled>Chargement...</button>
      </div>
      <div class="execution-output" id="output-${flow.id}">
        <div class="execution-header">
          <span class="execution-status" id="exec-status-${flow.id}"></span>
          <span class="log-toggle" onclick="toggleLogs('${flow.id}')" id="log-toggle-${flow.id}">Afficher les logs</span>
        </div>
        <div class="execution-log" id="exec-log-${flow.id}" style="display:none"></div>
      </div>
      <div class="history-section" id="history-${flow.id}">
        <div class="history-header" onclick="toggleHistory('${flow.id}')">
          <span>Historique des executions</span>
          <span class="history-toggle" id="history-toggle-${flow.id}">&#9654;</span>
        </div>
        <div class="history-content" id="history-content-${flow.id}" style="display:none">
          <div class="history-list" id="history-list-${flow.id}"></div>
        </div>
      </div>
    </div>
  `
    )
    .join("");
}

function renderFlowDetail(flowId, detail) {
  // Services
  const servicesEl = document.getElementById(`services-${flowId}`);
  if (servicesEl) {
    servicesEl.innerHTML = detail.requires.services
      .map((svc) => {
        const isConnected = svc.status === "connected";
        return `
        <span class="service ${isConnected ? "" : "not-connected"}"
              ${!isConnected ? `onclick="connectService('${svc.provider}')"` : ""}
              title="${svc.description}">
          <span class="status-dot ${isConnected ? "connected" : "disconnected"}"></span>
          ${svc.id}
          ${!isConnected ? " (connecter)" : ""}
        </span>
      `;
      })
      .join("");
  }

  // Actions
  const actionsEl = document.getElementById(`actions-${flowId}`);
  const allConnected = detail.requires.services.every((s) => s.status === "connected");
  const hasRequiredConfig = checkRequiredConfig(detail);
  const hasInputSchema = detail.input?.schema && Object.keys(detail.input.schema).length > 0;

  if (actionsEl) {
    const runAction = hasInputSchema ? `openInputModal('${flowId}')` : `runFlow('${flowId}')`;
    actionsEl.innerHTML = `
      <button onclick="openConfigModal('${flowId}')">Configurer</button>
      <button class="primary"
              onclick="${runAction}"
              ${!allConnected || !hasRequiredConfig ? "disabled" : ""}
              title="${!allConnected ? "Connectez tous les services d'abord" : !hasRequiredConfig ? "Configurez les champs obligatoires" : "Lancer le flow"}">
        Lancer
      </button>
    `;
  }

  // Load execution history
  loadExecutionHistory(flowId);
}

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

// --- Config Modal ---

function openConfigModal(flowId) {
  currentFlowId = flowId;
  const detail = flowsData[flowId];
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
          <label>${key}${required}</label>
          <select id="config-${key}" data-key="${key}">
            ${field.enum.map((v) => `<option value="${v}" ${v === value ? "selected" : ""}>${v}</option>`).join("")}
          </select>
          <div class="hint">${field.description}</div>
        </div>
      `;
      }

      return `
      <div class="form-group">
        <label>${key}${required}</label>
        <input type="${field.type === "number" ? "number" : "text"}"
               id="config-${key}"
               data-key="${key}"
               value="${value || ""}"
               placeholder="${field.description}">
        <div class="hint">${field.description}</div>
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

  const detail = flowsData[currentFlowId];
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

    // Reload flow detail
    const detail = await api(`/flows/${currentFlowId}`);
    flowsData[currentFlowId] = detail;
    renderFlowDetail(currentFlowId, detail);

    closeConfigModal();
  } catch (err) {
    alert(`Erreur : ${err.message}`);
  }
}

// --- Connect Service ---

async function connectService(provider) {
  try {
    // Create a connect session server-side (auth routes are at /auth, not /api)
    const token = localStorage.getItem("openflows_token") || "";
    const res = await fetch(`/auth/connect/${provider}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(err.message || `Error: ${res.status}`);
    }
    const session = await res.json();

    // Open Nango Connect in a popup
    const popup = window.open(session.connectLink, "oauth", "width=600,height=700");

    // Poll for popup close, then refresh
    const interval = setInterval(() => {
      if (popup && popup.closed) {
        clearInterval(interval);
        init();
      }
    }, 500);
  } catch (err) {
    alert(`Erreur de connexion : ${err.message}`);
  }
}

// --- Input Modal ---

function openInputModal(flowId) {
  currentFlowId = flowId;
  const detail = flowsData[flowId];
  if (!detail) return;

  document.getElementById("inputModalTitle").textContent = `${detail.displayName} — Paramètres`;

  const schema = detail.input?.schema || {};

  const formHtml = Object.entries(schema)
    .map(([key, field]) => {
      const value = field.default ?? "";
      const required = field.required ? " *" : "";

      return `
      <div class="form-group">
        <label>${key}${required}</label>
        <input type="${field.type === "number" ? "number" : "text"}"
               id="input-${key}"
               data-key="${key}"
               value="${value || ""}"
               placeholder="${field.placeholder || field.description}">
        <div class="hint">${field.description}</div>
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

  const detail = flowsData[currentFlowId];
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
  runFlow(flowId, input);
}

// --- Run Flow ---

async function runFlow(flowId, inputData) {
  const outputEl = document.getElementById(`output-${flowId}`);
  const logEl = document.getElementById(`exec-log-${flowId}`);
  const statusEl = document.getElementById(`exec-status-${flowId}`);

  // Show output area
  outputEl.classList.add("active");
  logEl.innerHTML = "";
  delete pendingResults[flowId];
  statusEl.innerHTML = `<span class="spinner"></span> Démarrage...`;

  // Disable run button
  const runBtn = document.querySelector(`#actions-${flowId} .primary`);
  if (runBtn) runBtn.disabled = true;

  try {
    const token = localStorage.getItem("openflows_token") || "";
    const res = await fetch(`${API_BASE}/flows/${flowId}/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ stream: true, ...(inputData ? { input: inputData } : {}) }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(err.message || `Error: ${res.status}`);
    }

    // Read SSE stream
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
          const dataStr = line.slice(6);
          try {
            const data = JSON.parse(dataStr);
            handleSSEEvent(flowId, eventType, data);
          } catch {}
          eventType = null;
        }
      }
    }
  } catch (err) {
    appendLog(logEl, `Erreur : ${err.message}`, "error");
    statusEl.innerHTML = `<span class="status-dot disconnected"></span> Erreur`;
  } finally {
    if (runBtn) runBtn.disabled = false;
  }
}

function handleSSEEvent(flowId, event, data) {
  const logEl = document.getElementById(`exec-log-${flowId}`);
  const statusEl = document.getElementById(`exec-status-${flowId}`);

  switch (event) {
    case "execution_started":
      statusEl.innerHTML = `<span class="spinner"></span> Exécution en cours...`;
      appendLog(logEl, `Exécution démarrée (${data.executionId})`, "progress");
      break;

    case "dependency_check":
      const checks = Object.entries(data.services || {})
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ");
      appendLog(logEl, `Dépendances vérifiées — ${checks}`, "progress");
      break;

    case "adapter_started":
      appendLog(logEl, `Adapter ${data.adapter || "unknown"} démarré`, "progress");
      break;

    case "progress":
      appendLog(logEl, data.message, "progress");
      break;

    case "result":
      pendingResults[flowId] = data;
      break;

    case "execution_completed":
      if (data.status === "success") {
        statusEl.innerHTML = `<span class="status-dot connected"></span> Terminé`;
      } else if (data.status === "timeout") {
        statusEl.innerHTML = `<span class="status-dot disconnected"></span> Timeout`;
        appendLog(logEl, "L'exécution a dépassé le temps imparti", "error");
      } else {
        statusEl.innerHTML = `<span class="status-dot disconnected"></span> Échec`;
        if (data.error) appendLog(logEl, data.error, "error");
      }
      // Refresh history and auto-expand latest execution
      loadExecutionHistory(flowId, true);
      break;
  }
}

function appendLog(logEl, message, type = "progress") {
  const entry = document.createElement("div");
  entry.className = `log-entry ${type}`;
  entry.textContent = message;
  logEl.appendChild(entry);
  logEl.scrollTop = logEl.scrollHeight;
}

function toggleLogs(flowId) {
  const logEl = document.getElementById(`exec-log-${flowId}`);
  const toggleEl = document.getElementById(`log-toggle-${flowId}`);
  const isHidden = logEl.style.display === "none";
  logEl.style.display = isHidden ? "block" : "none";
  toggleEl.textContent = isHidden ? "Masquer les logs" : "Afficher les logs";
}

// --- Result Rendering ---

function renderMetadata(data) {
  const parts = [];
  if (data.emails_processed !== undefined) parts.push(`${data.emails_processed} mails traités`);
  if (data.emails_scanned !== undefined) parts.push(`${data.emails_scanned} mails scannés`);
  if (data.newsletters_found !== undefined) parts.push(`${data.newsletters_found} newsletters trouvées`);
  if (data.ignored_count) parts.push(`${data.ignored_count} ignorés`);
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
  targetEl.style.display = "block";

  let html = `<h4>Résultat</h4>`;

  // Summary with markdown support
  if (data.summary) {
    html += `<div class="result-summary">${convertMarkdown(data.summary)}</div>`;
  }

  // Backward compat: email-to-tickets format
  if (data.tickets_created && data.tickets_created.length > 0) {
    html += `<h4>Tickets créés</h4><ul class="ticket-list">`;
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

  // Generic results[] array (newsletter items, etc.)
  if (data.results && data.results.length > 0) {
    html += renderResultItems(data.results);
  }

  // Metadata (emails_processed, tokens, etc.)
  html += renderMetadata(data);

  // Fallback: if no known fields matched, show raw JSON
  const knownKeys = ["summary", "tickets_created", "informational", "results", "emails_processed", "emails_scanned", "newsletters_found", "ignored_count", "tokensUsed", "state"];
  const hasKnownField = Object.keys(data).some((k) => knownKeys.includes(k));
  if (!hasKnownField) {
    html += `<pre style="font-size: 0.75rem; overflow-x: auto; white-space: pre-wrap; color: var(--text-muted)">${escapeHtml(JSON.stringify(data, null, 2))}</pre>`;
  }

  targetEl.innerHTML = html;
}

// --- Execution History ---

function toggleHistory(flowId) {
  const content = document.getElementById(`history-content-${flowId}`);
  const toggle = document.getElementById(`history-toggle-${flowId}`);
  const isOpen = content.style.display !== "none";
  content.style.display = isOpen ? "none" : "block";
  toggle.innerHTML = isOpen ? "&#9654;" : "&#9660;";
}

async function loadExecutionHistory(flowId, autoExpandFirst = false) {
  const listEl = document.getElementById(`history-list-${flowId}`);
  if (!listEl) return;

  try {
    const { executions } = await api(`/flows/${flowId}/executions?limit=10`);
    if (!executions || executions.length === 0) {
      listEl.innerHTML = `<div class="history-empty">Aucune exécution précédente</div>`;
      return;
    }

    listEl.innerHTML = executions
      .map((exec) => {
        const date = new Date(exec.started_at).toLocaleString("fr-FR", {
          day: "2-digit", month: "2-digit", year: "numeric",
          hour: "2-digit", minute: "2-digit",
        });
        const statusClass = exec.status === "success" ? "connected" : exec.status === "running" ? "running" : "disconnected";
        const duration = exec.duration ? `${(exec.duration / 1000).toFixed(1)}s` : "";
        const inputPreview = exec.input ? truncate(JSON.stringify(exec.input), 60) : "";
        const errorClass = exec.status === "failed" || exec.status === "timeout" ? " history-item-error" : "";

        return `
          <div class="history-item${errorClass}" data-exec-id="${exec.id}" data-rendered="false">
            <div class="history-item-header" onclick="toggleHistoryItem(this)">
              <span class="status-dot ${statusClass}"></span>
              <span class="history-item-date">${date}</span>
              <span class="history-item-status">${exec.status}</span>
              ${duration ? `<span class="history-item-duration">${duration}</span>` : ""}
              ${inputPreview ? `<span class="history-item-input">${escapeHtml(inputPreview)}</span>` : ""}
            </div>
            <div class="history-item-detail" style="display:none"></div>
          </div>
        `;
      })
      .join("");

    // Auto-expand the latest execution after a run completes
    if (autoExpandFirst) {
      // Open history section if collapsed
      const content = document.getElementById(`history-content-${flowId}`);
      const toggle = document.getElementById(`history-toggle-${flowId}`);
      if (content && content.style.display === "none") {
        content.style.display = "block";
        toggle.innerHTML = "&#9660;";
      }

      // Expand first item with cached result (avoids extra API call)
      const firstItem = listEl.querySelector(".history-item");
      if (firstItem) {
        const detail = firstItem.querySelector(".history-item-detail");
        detail.style.display = "block";

        const cachedResult = pendingResults[flowId];
        if (cachedResult) {
          firstItem.dataset.rendered = "true";
          const resultDiv = document.createElement("div");
          resultDiv.className = "history-item-result";
          detail.appendChild(resultDiv);
          renderResult(cachedResult, resultDiv);
          delete pendingResults[flowId];
        } else {
          // Fallback: trigger lazy load via toggleHistoryItem
          const headerEl = firstItem.querySelector(".history-item-header");
          toggleHistoryItem(headerEl);
        }
      }
    }
  } catch {
    listEl.innerHTML = `<div class="history-empty">Impossible de charger l'historique</div>`;
  }
}

function truncate(str, max) {
  if (str.length <= max) return str;
  return str.slice(0, max) + "...";
}

async function toggleHistoryItem(headerEl) {
  const item = headerEl.parentElement;
  const detail = item.querySelector(".history-item-detail");
  const isOpen = detail.style.display !== "none";

  if (isOpen) {
    detail.style.display = "none";
    return;
  }

  detail.style.display = "block";

  // Lazy load: only fetch on first expand
  if (item.dataset.rendered === "false") {
    item.dataset.rendered = "true";
    detail.innerHTML = `<div class="history-loading"><span class="spinner"></span> Chargement...</div>`;

    try {
      const exec = await api(`/executions/${item.dataset.execId}`);
      if (exec.result) {
        detail.innerHTML = "";
        const resultDiv = document.createElement("div");
        resultDiv.className = "history-item-result";
        resultDiv.style.display = "block";
        detail.appendChild(resultDiv);
        renderResult(exec.result, resultDiv);
      } else if (exec.error) {
        detail.innerHTML = `<div class="history-item-result"><p class="log-entry error">${escapeHtml(exec.error)}</p></div>`;
      } else {
        detail.innerHTML = `<div class="history-item-result"><p class="result-metadata">Aucun résultat disponible</p></div>`;
      }
    } catch (err) {
      detail.innerHTML = `<div class="history-item-result"><p class="log-entry error">Erreur : ${escapeHtml(err.message)}</p></div>`;
    }
  }
}

// Close modal on overlay click
document.getElementById("configModal").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) closeConfigModal();
});
document.getElementById("inputModal").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) closeInputModal();
});

// Close modals on Escape
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeConfigModal();
    closeInputModal();
  }
});

// Init
init();
