/** Make authenticated API requests to connected services via the platform's credential broker. */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";

const PLATFORM_API_URL = process.env.PLATFORM_API_URL || "http://host.docker.internal:3000";
const EXECUTION_TOKEN = process.env.EXECUTION_TOKEN || "";
const CONNECTED_SERVICES = (process.env.CONNECTED_SERVICES || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// --- Types ---

type ToolResult = { content: [{ type: "text"; text: string }] };

type BodyBuildResult =
  | { body: string | Uint8Array | FormData | undefined; contentType?: string; error?: undefined }
  | { error: string; body?: undefined; contentType?: undefined };

interface ValidatedFile {
  buffer: Uint8Array;
  filename: string;
  size: number;
}

interface CredentialsResponse {
  credentials: Record<string, string>;
  authorizedUris: string[] | null;
}

// --- Helpers ---

function errorResult(message: string): ToolResult {
  return { content: [{ type: "text" as const, text: `Error: ${message}` }] };
}

function successResult(text: string): ToolResult {
  return { content: [{ type: "text" as const, text }] };
}

async function fetchCredentials(
  serviceId: string,
  signal?: AbortSignal,
): Promise<CredentialsResponse> {
  const res = await fetch(`${PLATFORM_API_URL}/internal/credentials/${serviceId}`, {
    headers: { Authorization: `Bearer ${EXECUTION_TOKEN}` },
    signal,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to fetch credentials for ${serviceId}: ${res.status} ${body}`);
  }
  return res.json() as Promise<CredentialsResponse>;
}

/** Substitute {{variable}} placeholders with actual credential values */
function substituteVars(text: string, credentials: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_match, key) => credentials[key] ?? _match);
}

/** URI matching: '*' at end = prefix match, otherwise exact match */
function matchesAuthorizedUri(url: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern.endsWith("*")) {
      return url.startsWith(pattern.slice(0, -1));
    }
    return url === pattern;
  });
}

function validateFile(filePath: string): ValidatedFile | string {
  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) return `File not found: ${resolvedPath}`;
  const stats = fs.statSync(resolvedPath);
  return {
    buffer: new Uint8Array(fs.readFileSync(resolvedPath)),
    filename: path.basename(resolvedPath),
    size: stats.size,
  };
}

// --- Body builders ---

function buildMultipartRelated(
  jsonMetadata: string,
  fileBuffer: Uint8Array,
  fileContentType: string,
): { body: Uint8Array; contentType: string } {
  const boundary = `----appstrate-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const crlf = "\r\n";

  const parts = [
    `--${boundary}${crlf}`,
    `Content-Type: application/json; charset=UTF-8${crlf}${crlf}`,
    jsonMetadata,
    `${crlf}--${boundary}${crlf}`,
    `Content-Type: ${fileContentType}${crlf}`,
    `Content-Transfer-Encoding: binary${crlf}${crlf}`,
  ];

  const encoder = new TextEncoder();
  const preamble = encoder.encode(parts.join(""));
  const epilogue = encoder.encode(`${crlf}--${boundary}--${crlf}`);

  const result = new Uint8Array(preamble.length + fileBuffer.length + epilogue.length);
  result.set(preamble, 0);
  result.set(fileBuffer, preamble.length);
  result.set(epilogue, preamble.length + fileBuffer.length);

  return {
    body: result,
    contentType: `multipart/related; boundary=${boundary}`,
  };
}

function buildTextBody(
  bodyText: string | undefined,
  hasContentTypeHeader: boolean,
): BodyBuildResult {
  if (!bodyText) return { body: undefined };
  return {
    body: bodyText,
    contentType: hasContentTypeHeader ? undefined : "application/json",
  };
}

function buildFileBody(
  filePath: string,
  fileContentType: string | undefined,
  bodyText: string | undefined,
  hasContentTypeHeader: boolean,
): BodyBuildResult {
  if (!fileContentType) {
    return { error: "fileContentType is required when filePath is provided." };
  }

  const validated = validateFile(filePath);
  if (typeof validated === "string") return { error: validated };

  if (bodyText) {
    // Multipart/related: JSON metadata + file binary
    const multipart = buildMultipartRelated(bodyText, validated.buffer, fileContentType);
    return { body: multipart.body, contentType: multipart.contentType };
  }

  // Raw binary upload
  return {
    body: validated.buffer,
    contentType: hasContentTypeHeader ? undefined : fileContentType,
  };
}

interface FormDataField {
  name: string;
  value?: string;
  filePath?: string;
  filename?: string;
  contentType?: string;
}

function buildFormDataBody(
  fields: FormDataField[],
  credentials: Record<string, string>,
): BodyBuildResult {
  const formData = new FormData();

  for (const field of fields) {
    if (field.filePath) {
      const validated = validateFile(field.filePath);
      if (typeof validated === "string") return { error: validated };
      const mime = field.contentType || "application/octet-stream";
      const filename = field.filename || validated.filename;
      const file = new File([validated.buffer], filename, { type: mime });
      formData.append(field.name, file);
    } else if (field.value !== undefined) {
      formData.append(field.name, substituteVars(field.value, credentials));
    } else {
      return { error: `Form field "${field.name}" must have either value or filePath.` };
    }
  }

  // Don't set contentType — fetch() auto-generates it with the correct boundary
  return { body: formData };
}

// --- Main ---

export default function (pi: ExtensionAPI) {
  const serviceList =
    CONNECTED_SERVICES.length > 0
      ? `Available services: ${CONNECTED_SERVICES.join(", ")}`
      : "No services connected";

  pi.registerTool({
    name: "api_request",
    label: "API Request",
    description: `Make an authenticated HTTP request to a connected service. Use {{variable}} placeholders in path, headers, and body — the platform substitutes them with real credentials. Supports 4 body modes: (1) JSON/text body, (2) raw binary file upload (filePath + fileContentType), (3) multipart/related (filePath + body + fileContentType, for Google Drive), (4) multipart/form-data (formData fields, for Slack, SendGrid, most REST APIs). ${serviceList}.`,
    parameters: Type.Object({
      service: Type.String({
        description: "The service ID to call (e.g. 'gmail', 'clickup', 'brevo')",
      }),
      path: Type.String({
        description:
          "The full URL to call (e.g. 'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=20')",
      }),
      method: Type.Optional(
        Type.String({ description: "HTTP method (default: GET)", default: "GET" }),
      ),
      body: Type.Optional(
        Type.String({
          description:
            "Request body as JSON string (for POST/PUT/PATCH). Use {{variable}} for credentials. When combined with filePath, treated as JSON metadata for multipart/related upload.",
        }),
      ),
      headers: Type.Optional(
        Type.Record(Type.String(), Type.String(), {
          description:
            'HTTP headers. Use {{variable}} for credentials (e.g. {"Authorization": "Bearer {{token}}"})',
        }),
      ),
      filePath: Type.Optional(
        Type.String({
          description:
            "Path to a local file to upload. Combined with body: multipart/related (metadata + file). Without body: raw binary upload.",
        }),
      ),
      fileContentType: Type.Optional(
        Type.String({
          description:
            "MIME type of the file (e.g. 'application/pdf', 'image/png'). Required when filePath is provided.",
        }),
      ),
      formData: Type.Optional(
        Type.Array(
          Type.Object({
            name: Type.String({ description: "Form field name" }),
            value: Type.Optional(
              Type.String({
                description:
                  "Text value for regular form fields. Supports {{variable}} credential substitution.",
              }),
            ),
            filePath: Type.Optional(
              Type.String({
                description: "Absolute path to a local file for file upload fields.",
              }),
            ),
            filename: Type.Optional(
              Type.String({
                description:
                  "Override filename in Content-Disposition (defaults to basename of filePath).",
              }),
            ),
            contentType: Type.Optional(
              Type.String({
                description:
                  "MIME type for file fields (e.g. 'application/pdf'). Defaults to 'application/octet-stream'.",
              }),
            ),
          }),
          {
            description:
              "Form fields for multipart/form-data upload (Slack, SendGrid, most REST APIs). Mutually exclusive with body and filePath.",
          },
        ),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      // 0. Mutual exclusivity check
      if (params.formData && (params.filePath || params.body)) {
        return errorResult("formData is mutually exclusive with filePath and body.");
      }

      // 1. Fetch credentials from the platform
      let creds: CredentialsResponse;
      try {
        creds = await fetchCredentials(params.service, signal);
      } catch (err) {
        return errorResult(
          `Failed to get credentials for service "${params.service}". ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // 2. Variable substitution in path, headers, body
      const url = substituteVars(params.path, creds.credentials);
      const method = params.method || "GET";
      const reqHeaders: Record<string, string> = {};

      if (params.headers) {
        for (const [k, v] of Object.entries(params.headers)) {
          reqHeaders[k] = substituteVars(v, creds.credentials);
        }
      }

      const body = params.body ? substituteVars(params.body, creds.credentials) : undefined;

      // 3. Validate URL against authorizedUris
      if (creds.authorizedUris && creds.authorizedUris.length > 0) {
        if (!matchesAuthorizedUri(url, creds.authorizedUris)) {
          return errorResult(
            `URL not authorized for service "${params.service}". Allowed: ${creds.authorizedUris.join(", ")}`,
          );
        }
      }

      // 4. Build body — flat dispatch
      const hasContentTypeHeader = "Content-Type" in reqHeaders;
      let buildResult: BodyBuildResult;

      if (params.formData) {
        buildResult = buildFormDataBody(params.formData, creds.credentials);
      } else if (params.filePath) {
        buildResult = buildFileBody(
          params.filePath,
          params.fileContentType,
          body,
          hasContentTypeHeader,
        );
      } else {
        buildResult = buildTextBody(body, hasContentTypeHeader);
      }

      if (buildResult.error) return errorResult(buildResult.error);
      if (buildResult.contentType) reqHeaders["Content-Type"] = buildResult.contentType;

      // 5. Make the API call — delete Content-Type for FormData (fetch sets it with boundary)
      const fetchHeaders = { ...reqHeaders };
      if (buildResult.body instanceof FormData) delete fetchHeaders["Content-Type"];

      try {
        const res = await fetch(url, {
          method,
          headers: fetchHeaders,
          body: buildResult.body,
          signal,
        });

        const text = await res.text();
        const truncated = text.slice(0, 50000);
        const wasTruncated = text.length > 50000;

        return successResult(
          `Status: ${res.status} ${res.statusText}\n\n${truncated}${wasTruncated ? "\n\n[Content truncated at 50000 characters]" : ""}`,
        );
      } catch (err) {
        return errorResult(
          `API request to ${url} failed. ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  });
}
