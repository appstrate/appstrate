import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { parseRequestInput } from "../../src/services/input-parser.ts";
import { ApiError } from "../../src/lib/errors.ts";

// --- Helpers ---

/** Create a minimal Hono app that parses a JSON body via parseRequestInput (no schema). */
function jsonApp(body: unknown) {
  const app = new Hono();
  app.post("/", async (c) => {
    // No inputSchema → skips validation + file handling entirely
    const result = await parseRequestInput(c);
    return c.json(result);
  });
  return app.request("/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Create a Hono app that runs parseRequestInput with a schema, with error handling. */
function requestWithSchema(
  reqBody: string | FormData,
  inputSchema: Parameters<typeof parseRequestInput>[1],
  headers?: Record<string, string>,
) {
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json({ detail: err.message }, err.status as any);
    return c.json({ detail: "Internal error" }, 500);
  });
  app.post("/", async (c) => {
    const result = await parseRequestInput(c, inputSchema);
    return c.json(result);
  });
  return app.request("/", { method: "POST", headers, body: reqBody });
}

function jsonAppWithSchema(body: unknown, inputSchema: Parameters<typeof parseRequestInput>[1]) {
  return requestWithSchema(JSON.stringify(body), inputSchema, { "Content-Type": "application/json" });
}

function formDataApp(formData: FormData, inputSchema: Parameters<typeof parseRequestInput>[1]) {
  return requestWithSchema(formData, inputSchema);
}

const FILE_SCHEMA_WITH_REQUIRED = {
  type: "object" as const,
  properties: {
    files: {
      type: "string",
      description: "Upload file",
      format: "uri",
      contentMediaType: "application/octet-stream",
    },
    title: { type: "string", description: "Optional title" },
  },
  required: ["files"],
};

const INPUT_SCHEMA_WITH_REQUIRED = {
  type: "object" as const,
  properties: {
    email: { type: "string", description: "User email" },
    message: { type: "string", description: "Optional message" },
  },
  required: ["email"],
};

// --- Tests ---

describe("parseRequestInput", () => {
  it("parses modelId and proxyId from JSON body", async () => {
    const res = await jsonApp({
      input: { text: "hello" },
      modelId: "model-abc",
      proxyId: "proxy-def",
    });
    const json = (await res.json()) as any;

    expect(json.input).toEqual({ text: "hello" });
    expect(json.modelId).toBe("model-abc");
    expect(json.proxyId).toBe("proxy-def");
  });

  it("modelId and proxyId are undefined when not provided", async () => {
    const res = await jsonApp({ input: { text: "hello" } });
    const json = (await res.json()) as any;

    expect(json.modelId).toBeUndefined();
    expect(json.proxyId).toBeUndefined();
  });

  it("works with empty body", async () => {
    const res = await jsonApp({});
    const json = (await res.json()) as any;

    expect(json.input).toBeUndefined();
    expect(json.modelId).toBeUndefined();
    expect(json.proxyId).toBeUndefined();
  });

  it("proxyId 'none' is passed through as string", async () => {
    const res = await jsonApp({ proxyId: "none" });
    const json = (await res.json()) as any;

    expect(json.proxyId).toBe("none");
  });
});

describe("parseRequestInput — input schema validation", () => {
  it("rejects missing required field", async () => {
    const res = await jsonAppWithSchema(
      { input: { message: "hi" } },
      INPUT_SCHEMA_WITH_REQUIRED,
    );
    expect(res.status).toBe(400);
  });

  it("rejects undefined input when schema has required fields", async () => {
    const res = await jsonAppWithSchema({}, INPUT_SCHEMA_WITH_REQUIRED);
    expect(res.status).toBe(400);
  });

  it("rejects empty string on required field", async () => {
    const res = await jsonAppWithSchema(
      { input: { email: "" } },
      INPUT_SCHEMA_WITH_REQUIRED,
    );
    expect(res.status).toBe(400);
  });

  it("rejects null on required field", async () => {
    const res = await jsonAppWithSchema(
      { input: { email: null } },
      INPUT_SCHEMA_WITH_REQUIRED,
    );
    expect(res.status).toBe(400);
  });

  it("accepts valid input with required field present", async () => {
    const res = await jsonAppWithSchema(
      { input: { email: "test@example.com" } },
      INPUT_SCHEMA_WITH_REQUIRED,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.input.email).toBe("test@example.com");
  });

  it("accepts input with only required fields (optional omitted)", async () => {
    const res = await jsonAppWithSchema(
      { input: { email: "test@example.com" } },
      INPUT_SCHEMA_WITH_REQUIRED,
    );
    expect(res.status).toBe(200);
  });

  it("skips validation when no schema provided", async () => {
    const res = await jsonAppWithSchema({ input: { anything: true } }, undefined);
    expect(res.status).toBe(200);
  });

  it("accepts empty input when schema has no required fields", async () => {
    const optionalSchema = {
      type: "object" as const,
      properties: {
        note: { type: "string" },
      },
    };
    const res = await jsonAppWithSchema({}, optionalSchema);
    expect(res.status).toBe(200);
  });
});

describe("parseRequestInput — required file validation", () => {
  it("rejects FormData with no files when file field is required", async () => {
    const formData = new FormData();
    formData.set("input", JSON.stringify({}));

    const res = await formDataApp(formData, FILE_SCHEMA_WITH_REQUIRED);
    expect(res.status).toBe(400);
    const json = (await res.json()) as any;
    expect(json.detail).toContain("files");
  });

  it("accepts FormData with required file present", async () => {
    const formData = new FormData();
    formData.set("input", JSON.stringify({}));
    formData.set("files", new File(["hello"], "test.txt", { type: "text/plain" }));

    const res = await formDataApp(formData, FILE_SCHEMA_WITH_REQUIRED);
    expect(res.status).toBe(200);
  });

  it("accepts FormData when file field is optional and no file provided", async () => {
    const optionalFileSchema = {
      type: "object" as const,
      properties: {
        files: {
          type: "string",
          description: "Optional file",
          format: "uri",
          contentMediaType: "application/octet-stream",
        },
      },
    };
    const formData = new FormData();
    formData.set("input", JSON.stringify({}));

    const res = await formDataApp(formData, optionalFileSchema);
    expect(res.status).toBe(200);
  });
});
