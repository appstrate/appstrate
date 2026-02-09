// OpenFlows — Minimal SPA Client

const API_BASE = "/api";
let currentFlowId = null;
let flowsData = {};

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
        </div>
        <div class="execution-log" id="exec-log-${flow.id}"></div>
        <div class="result-section" id="exec-result-${flow.id}" style="display:none"></div>
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

  if (actionsEl) {
    actionsEl.innerHTML = `
      <button onclick="openConfigModal('${flowId}')">Configurer</button>
      <button class="primary"
              onclick="runFlow('${flowId}')"
              ${!allConnected || !hasRequiredConfig ? "disabled" : ""}
              title="${!allConnected ? "Connectez tous les services d'abord" : !hasRequiredConfig ? "Configurez les champs obligatoires" : "Lancer le flow"}">
        Lancer
      </button>
    `;
  }
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

// --- Run Flow ---

async function runFlow(flowId) {
  const outputEl = document.getElementById(`output-${flowId}`);
  const logEl = document.getElementById(`exec-log-${flowId}`);
  const statusEl = document.getElementById(`exec-status-${flowId}`);
  const resultEl = document.getElementById(`exec-result-${flowId}`);

  // Show output area
  outputEl.classList.add("active");
  logEl.innerHTML = "";
  resultEl.style.display = "none";
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
      body: JSON.stringify({ stream: true }),
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
  const resultEl = document.getElementById(`exec-result-${flowId}`);

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
      renderResult(flowId, data);
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

function renderResult(flowId, data) {
  const resultEl = document.getElementById(`exec-result-${flowId}`);
  resultEl.style.display = "block";

  let html = `<h4>Résultat</h4>`;

  if (data.summary) {
    html += `<p class="result-summary">${data.summary}</p>`;
  }

  if (data.tickets_created && data.tickets_created.length > 0) {
    html += `<h4>Tickets créés</h4><ul class="ticket-list">`;
    for (const ticket of data.tickets_created) {
      html += `<li>
        ${ticket.url ? `<a href="${ticket.url}" target="_blank">${ticket.title}</a>` : ticket.title}
        ${ticket.priority ? ` — ${ticket.priority}` : ""}
      </li>`;
    }
    html += `</ul>`;
  }

  if (data.informational && data.informational.length > 0) {
    html += `<h4 style="margin-top: 0.75rem">Mails informatifs</h4><ul class="ticket-list">`;
    for (const info of data.informational) {
      html += `<li><strong>${info.from}</strong>: ${info.summary || info.subject}</li>`;
    }
    html += `</ul>`;
  }

  if (data.emails_processed !== undefined) {
    html += `<p style="margin-top: 0.75rem; font-size: 0.75rem; color: var(--text-muted)">
      ${data.emails_processed} mails traités${data.ignored_count ? `, ${data.ignored_count} ignorés` : ""}
      ${data.tokensUsed ? ` — ${data.tokensUsed} tokens` : ""}
    </p>`;
  }

  resultEl.innerHTML = html;
}

// Close modal on overlay click
document.getElementById("configModal").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) closeConfigModal();
});

// Close modal on Escape
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeConfigModal();
});

// Init
init();
