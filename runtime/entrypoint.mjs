import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

const FLOW_PROMPT = process.env.FLOW_PROMPT || "";
const LLM_MODEL = process.env.LLM_MODEL || "claude-sonnet-4-5-20250929";
const TOKEN_GMAIL = process.env.TOKEN_GMAIL || "";
const TOKEN_CLICKUP = process.env.TOKEN_CLICKUP || "";

// Helper to emit structured messages on stdout
function emit(type, data) {
  console.log(JSON.stringify({ type, ...data }));
}

function emitProgress(message) {
  emit("progress", { message });
}

// --- Gmail Tool Implementations ---

async function gmailListMessages({ query, maxResults }) {
  emitProgress(`Recherche de mails : "${query || "tous"}" (max: ${maxResults || 20})...`);

  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (maxResults) params.set("maxResults", String(maxResults));

  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`,
    { headers: { Authorization: `Bearer ${TOKEN_GMAIL}` } }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gmail API error: ${res.status} ${err}`);
  }

  const data = await res.json();
  return data;
}

async function gmailGetMessage({ messageId }) {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`,
    { headers: { Authorization: `Bearer ${TOKEN_GMAIL}` } }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gmail API error: ${res.status} ${err}`);
  }

  const data = await res.json();

  // Extract useful fields
  const headers = data.payload?.headers || [];
  const getHeader = (name) => headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || "";

  // Extract body text
  let body = "";
  if (data.payload?.body?.data) {
    body = Buffer.from(data.payload.body.data, "base64url").toString("utf-8");
  } else if (data.payload?.parts) {
    const textPart = data.payload.parts.find((p) => p.mimeType === "text/plain");
    if (textPart?.body?.data) {
      body = Buffer.from(textPart.body.data, "base64url").toString("utf-8");
    }
  }

  return {
    id: data.id,
    threadId: data.threadId,
    from: getHeader("From"),
    to: getHeader("To"),
    subject: getHeader("Subject"),
    date: getHeader("Date"),
    snippet: data.snippet,
    body: body.slice(0, 2000), // Limit body size
    labelIds: data.labelIds,
  };
}

// --- ClickUp Tool Implementations ---

async function clickupCreateTask({ listId, name, description, priority }) {
  emitProgress(`Création du ticket : "${name}"...`);

  const res = await fetch(`https://api.clickup.com/api/v2/list/${listId}/task`, {
    method: "POST",
    headers: {
      Authorization: TOKEN_CLICKUP,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name,
      description: description || "",
      priority: priority || 3, // 1=urgent, 2=high, 3=normal, 4=low
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`ClickUp API error: ${res.status} ${err}`);
  }

  const task = await res.json();
  emitProgress(`Ticket créé : ${task.name} (${task.url})`);

  return {
    id: task.id,
    name: task.name,
    url: task.url,
    status: task.status?.status,
  };
}

// --- Tool definitions for Claude ---

const tools = [
  {
    name: "gmail_list_messages",
    description:
      "List Gmail messages matching a query. Returns message IDs and thread IDs. Use gmail_get_message to get full message details.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            'Gmail search query (e.g. "is:unread after:2026/02/08"). Leave empty for all messages.',
        },
        maxResults: {
          type: "number",
          description: "Maximum number of messages to return (default: 20)",
        },
      },
    },
  },
  {
    name: "gmail_get_message",
    description:
      "Get full details of a Gmail message by ID. Returns from, to, subject, date, snippet, and body text.",
    input_schema: {
      type: "object",
      properties: {
        messageId: {
          type: "string",
          description: "The Gmail message ID",
        },
      },
      required: ["messageId"],
    },
  },
  {
    name: "clickup_create_task",
    description:
      "Create a new task in a ClickUp list. Returns the created task with its URL.",
    input_schema: {
      type: "object",
      properties: {
        listId: {
          type: "string",
          description: "The ClickUp list ID where the task will be created",
        },
        name: {
          type: "string",
          description: "Task title - should be actionable (e.g. 'Répondre à...')",
        },
        description: {
          type: "string",
          description: "Task description with context from the email",
        },
        priority: {
          type: "number",
          description: "Priority: 1=urgent, 2=high, 3=normal, 4=low",
        },
      },
      required: ["listId", "name"],
    },
  },
];

// --- Tool execution router ---

async function executeTool(name, input) {
  switch (name) {
    case "gmail_list_messages":
      return await gmailListMessages(input);
    case "gmail_get_message":
      return await gmailGetMessage(input);
    case "clickup_create_task":
      return await clickupCreateTask(input);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// --- Main agent loop ---

async function main() {
  emitProgress("Démarrage de l'agent...");

  const messages = [{ role: "user", content: FLOW_PROMPT }];

  let totalTokens = 0;
  const maxIterations = 50; // Safety limit

  for (let i = 0; i < maxIterations; i++) {
    const response = await client.messages.create({
      model: LLM_MODEL,
      max_tokens: 4096,
      system:
        "You are an AI agent executing a flow. Use the provided tools to accomplish the task. Output your final result as a JSON object when done. Always communicate progress clearly.",
      tools,
      messages,
    });

    totalTokens += (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0);

    // Collect assistant response
    messages.push({ role: "assistant", content: response.content });

    // Check for text output (progress messages from the model)
    for (const block of response.content) {
      if (block.type === "text" && block.text.trim()) {
        // Check if it's a final JSON result
        const jsonMatch = block.text.match(/```json\n?([\s\S]*?)\n?```/);
        if (jsonMatch) {
          try {
            const result = JSON.parse(jsonMatch[1]);
            result.tokensUsed = totalTokens;
            emit("result", { data: result });
            return;
          } catch {}
        }

        // Try parsing the whole text as JSON
        try {
          const result = JSON.parse(block.text);
          result.tokensUsed = totalTokens;
          emit("result", { data: result });
          return;
        } catch {
          // Not JSON, emit as progress
          emitProgress(block.text.slice(0, 500));
        }
      }
    }

    // If model stopped (no tool use), we're done
    if (response.stop_reason === "end_turn") {
      // Try to extract result from the last text block
      const lastText = response.content.find((b) => b.type === "text");
      if (lastText) {
        try {
          const result = JSON.parse(lastText.text);
          result.tokensUsed = totalTokens;
          emit("result", { data: result });
        } catch {
          emit("result", {
            data: {
              summary: lastText.text,
              tokensUsed: totalTokens,
            },
          });
        }
      }
      return;
    }

    // Handle tool use
    if (response.stop_reason === "tool_use") {
      const toolResults = [];

      for (const block of response.content) {
        if (block.type === "tool_use") {
          try {
            const result = await executeTool(block.name, block.input);
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: JSON.stringify(result),
            });
          } catch (err) {
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: JSON.stringify({ error: err.message }),
              is_error: true,
            });
          }
        }
      }

      messages.push({ role: "user", content: toolResults });
    }
  }

  emit("result", {
    data: {
      summary: "Agent reached maximum iterations",
      tokensUsed: totalTokens,
      error: "MAX_ITERATIONS",
    },
  });
}

main().catch((err) => {
  // Output to stdout so the platform can capture it via Docker log stream
  emit("progress", { message: `Erreur: ${err.message}` });
  emit("result", {
    data: {
      error: err.message,
      summary: `L'agent a échoué : ${err.message}`,
    },
  });
  process.exit(1);
});
