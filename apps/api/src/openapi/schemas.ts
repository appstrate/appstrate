// SPDX-License-Identifier: Apache-2.0

import {
  credentialSourceValues,
  orgRoleEnum,
  packageSourceValues,
  packageTypeValues,
  runOriginValues,
  scheduleDisabledReasonValues,
} from "@appstrate/db/schema";
import { runStatusValues } from "@appstrate/core/run-status";
import {
  RUN_AND_WAIT_RESUME_INSTRUCTION,
  RUN_RESULT_INLINE_MAX_BYTES,
} from "@appstrate/core/run-and-wait-client";
import { SPACE_ROLE_PRESETS, SPACE_VISIBILITIES } from "@appstrate/core/permissions";
import { MODEL_INPUT_MODALITIES } from "@appstrate/core/module";
import {
  MODEL_REASONING_LEVELS,
  MODEL_REASONING_OFF_BEHAVIOURS,
  modelCapabilitySupportSchema,
} from "@appstrate/core/model-generation";
import { SELECTABLE_RUNTIME_TOOLS } from "@appstrate/core/runtime-tools-catalog";
import { MAX_TOKEN_USAGE_TIERS, TOKEN_USAGE_COUNTERS } from "@appstrate/afps-shared/token-usage";
import { SPACE_ID_RE } from "@appstrate/db/ids";
import {
  CONNECTION_RESOLUTION_ERROR_CODES,
  CONNECTION_RESOLUTION_SOURCES,
  CONNECTION_RESOLUTION_WARNING_CODES,
  CONNECT_FLOW_CODES,
  INTEGRATION_MANIFEST_FAILURE_CODES,
  MAX_CONNECTIONS_PER_INTEGRATION,
  MISSING_INTEGRATION_CONNECTION_CODES,
} from "@appstrate/core/integration";
import {
  connectionIdSetJsonSchema,
  connectionScopeSchema,
  originSpaceIdSchema,
  sharedHereSchema,
  sharedSpaceIdsSchema,
  spaceIdSchema,
} from "./paths/integrations.ts";

const ORG_ROLES = [...orgRoleEnum.enumValues];

/**
 * Prefix a custom space-role id carries. Only the prefix is published: the
 * server's full `srl_`+UUID rule is stricter, and a spec that pinned it would
 * turn a server-side id-shape change into a client-side break.
 */
export const SPACE_ROLE_ID_PATTERN = "^srl_";

/**
 * Runtime-tool ids a manifest may DECLARE — the canonical catalog
 * ({@link SELECTABLE_RUNTIME_TOOLS}) spread into the mutable `string[]` a JSON
 * Schema `enum` member takes. There is no second list to pick from and no
 * reason to import anything but the catalog itself.
 */
const RUNTIME_TOOL_IDS = [...SELECTABLE_RUNTIME_TOOLS];

const TOKEN_USAGE_COUNTER_PROPERTIES = Object.fromEntries(
  TOKEN_USAGE_COUNTERS.map((counter) => [counter, { type: "integer", minimum: 0 }]),
);

/**
 * The org-settings members, shared by the READ component (`OrgSettings`, below)
 * and the CLOSED write body of `PATCH /api/orgs/{orgId}/settings`
 * (`openapi/paths/organizations.ts`).
 *
 * The two cannot be one schema: `orgSettingsPatchSchema`
 * (`services/organizations.ts`) is `.strict()`, so an unknown key on the write
 * is a 400 — while `getOrgSettings` CASTS the JSONB column and returns it
 * verbatim, so the READ genuinely can carry keys this document does not name.
 * Closing the shared component would publish that read as a promise the server
 * does not keep. Sharing the PROPERTIES instead is what keeps the two halves
 * from drifting on the descriptions.
 */
/**
 * The `home_space_id` / `home_writable` / `home_deletable` / `home_shareable`
 * group, on every shape that carries a package's home (`AgentDetail`,
 * `OrgPackageItem`, `OrgPackageItemDetail`, `LibraryPackageList`,
 * `PackageHome`). ONE
 * definition: the server computes all four in one place (`homeWireForCaller`),
 * and four hand-copied descriptions drifted the moment the contract changed.
 */
const PACKAGE_HOME_PROPERTIES = {
  home_space_id: {
    type: ["string", "null"],
    description:
      "Space (`spc_…`) whose `<type>:write` authorizes editing, publishing, renaming and deleting this package — emitted ONLY when the caller reaches that space. `null` means the home is not a space this caller can see: a colleague's personal space, for instance, which is readable through a placement but never nameable, or a system package, which the platform ships into every space instead of housing in one. Use `home_writable` rather than inferring authority from this field. Other spaces the package is placed in consume it and never gain write authority.",
  },
  home_writable: {
    type: "boolean",
    description:
      "Whether THIS caller holds the package type's `write` in its home space — the exact predicate the write routes enforce (`PUT`, publish, restore, rename, move). `false` on a package the caller may read but not author, including one whose `home_space_id` is withheld. It does NOT answer for `DELETE`, which enforces `<type>:delete`: read `home_deletable` for that.",
  },
  home_deletable: {
    type: "boolean",
    description:
      "Whether THIS caller holds the package type's `delete` in its home space — the exact predicate `DELETE` enforces, and a field of its own because `<type>:delete` is an independent permission string a custom space role may withhold while granting `write`. Every preset that writes also deletes, so this equals `home_writable` for a preset-only organization. `false` on a system package, which no principal may delete.",
  },
  home_shareable: {
    type: "boolean",
    description:
      "Whether THIS caller holds the package type's `share` in its home space — the exact predicate every act that widens the audience enforces: the offer, the audience listing and the revoke (`/shares`), plus the activation that has to create the offer first (`POST /api/spaces/{spaceId}/packages` on a package this space does not yet hold). Activating an ALREADY-placed package asks for no `share`. `share` decides who runs the package with whose credentials, so it is granted by the `admin` and `builder` presets and carried by no API key; a custom role may hold it without `write`, or `write` without it.",
  },
} as const;

export const ORG_SETTINGS_PROPERTIES = {
  restrict_package_copy: {
    type: "boolean",
    description:
      "When true, copying a package OUT of the space that owns it requires the source package type's `share` in its home space: `POST /api/packages/{scope}/{name}/fork`, `GET /api/packages/{scope}/{name}/{version}/download` and `GET /api/agents/{scope}/{name}/bundle` answer `403 package_copy_restricted` otherwise. Default false — reading implies copying, as in Notion, Drive and Figma. SKILLS are exempt on all three: the CLI's `code sync` downloads them into a local checkout by design. A SERVER-side agent run is unaffected — it assembles the same bundle and hands it to nobody — but `appstrate run --local`, which downloads one, is not: a copy of the agent leaves the platform to perform it, which is what this setting is about.",
  },
  api_version: {
    type: "string",
    description:
      "Pinned API version for this organization (format: YYYY-MM-DD). Automatically set to the current version at org creation. New API versions do not affect existing orgs until explicitly updated. On write, a version the server cannot serve is rejected with `400 unsupported_api_version` — an unserveable pin would make every org-scoped route fail for this organization.",
  },
  dashboard_sso_enabled: {
    type: "boolean",
    description:
      "When true, org-level (dashboard) OAuth clients can be created and the SSO tab is exposed in the org settings UI. Defaults to false — most orgs only need space-level SSO for their end-users.",
  },
  personal_model_credentials: {
    type: "boolean",
    description:
      "Whether members may bring personal model credentials. Defaults to true. When false, adding one (`owner_type: user` on `POST /api/model-provider-credentials`, or a subscription pairing) answers `403 personal_model_credentials_disabled`, and the personal credentials that already exist serve nothing: a model the organization leaves unbound is refused (`409 model_credential_required`), and a run on one is refused at its next call.",
  },
};

/**
 * The two members of the per-space input layer, shared by the
 * `AgentInputSettings` component (below), by `AgentDetail.input`, and by the
 * CLOSED write body of `PUT /api/agents/{scope}/{name}/input-settings`
 * (`openapi/paths/agents.ts`).
 *
 * The write body cannot simply `$ref` the component and add
 * `additionalProperties: false`: that keyword does not compose through
 * `allOf`/`$ref` — it only sees the `properties` declared in the SAME schema
 * object. And the component itself cannot be closed, because `AgentDetail.input`
 * composes it with `schema` / `file_constraints` / `ui_hints`; closing the base
 * would make that conjunction unsatisfiable. Sharing the properties is the one
 * form that keeps `locked_fields` documented once.
 */
export const AGENT_INPUT_SETTINGS_PROPERTIES = {
  values: {
    type: "object",
    description:
      "Values stored for this space. Validated against the manifest `input.schema` with `required` dropped: leaving a required field empty here means it is asked at launch.",
    additionalProperties: true,
  },
  locked_fields: {
    type: "array",
    items: { type: "string", minLength: 1 },
    description:
      "Input fields no caller may set at launch. A run or schedule that sets one is refused with 400 `locked_input_field`. A required field may not be locked unless it has a value (author `default` or an entry in `values`) — otherwise the write is refused with 400 `locked_required_field_empty`.",
  },
};

/** What every `run_and_wait` result carries, whether the run ended or the wait did. */
const RUN_AND_WAIT_REQUIRED = ["id", "packageId", "status", "done", "warnings"];
const RUN_AND_WAIT_COMMON_PROPERTIES = {
  id: { type: ["string", "null"], description: "The run id." },
  packageId: { type: ["string", "null"], description: "The run's agent (`@scope/name`)." },
  status: { type: ["string", "null"], enum: [...runStatusValues, null] },
  warnings: {
    type: "array",
    description: "The launch's `warnings` (see LaunchWarnings); `[]` when none.",
    items: { $ref: "#/components/schemas/ConnectionResolutionWarning" },
  },
  space: {
    type: "object",
    description:
      "The space the run was launched in. Present on an org-wide MCP connection only, where each call names its space.",
    required: ["id", "name"],
    additionalProperties: false,
    properties: { id: { type: "string" }, name: { type: "string" } },
  },
};

/**
 * All OpenAPI schema definitions (components/schemas).
 */
export const schemas = {
  // Shared field-error item carrying the connection-resolution "smuggle"
  // fields surfaced by services/integration-connection-resolver.ts:
  // translateResolutionError (mirrors the `ResolutionFieldError` TS type in
  // @appstrate/core/api-errors). Extracted into one component so every
  // consumer (ProblemDetail.errors, and any future readiness DTO) shares one
  // shape and can't drift. The base four (`field`/`code`/`message`/`title`)
  // come from ValidationFieldError; the extras are each
  // populated only for the matching resolution `code`(s) and so are all optional.
  ResolutionFieldError: {
    type: "object",
    required: ["field", "code", "message"],
    properties: {
      field: { type: "string" },
      code: {
        type: "string",
        description: `On a connection-resolution item (\`field: integrations.<id>\`) one of ${CONNECTION_RESOLUTION_ERROR_CODES.map((c) => `\`${c}\``).join(", ")} — the extras below are keyed on it — or one of ${INTEGRATION_MANIFEST_FAILURE_CODES.map((c) => `\`${c}\``).join(", ")} (the declared integration's manifest could not be loaded; no extras), or, on \`POST /api/runs/remote\` only, \`remote_binds_one_connection\` (the cascade binds several connections to an integration, and a remote runner addresses one per integration; no extras). On a launch response's \`warnings[]\` item, one of ${CONNECTION_RESOLUTION_WARNING_CODES.map((c) => `\`${c}\``).join(", ")} (see ConnectionResolutionWarning). On any other validation item, the validator's own code.`,
      },
      message: { type: "string" },
      title: {
        type: "string",
        description: "Human-readable title; preserved from the underlying error factory.",
      },
      // Channel-specific smuggles surfaced by services/integration-connection-resolver.ts:translateResolutionError.
      // Documented here so SDK consumers can rely on them without reading the resolver source.
      candidate_connections: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "label", "account_id", "owned_by_actor", "needs_reconnection"],
          properties: {
            id: { type: "string" },
            label: {
              type: "string",
              description:
                "User-given name. Always present — the column is NOT NULL, because a run binding several connections addresses each by its label.",
            },
            account_id: {
              type: "string",
              description: "The auth's account discriminator (`sub` claim, email, host…).",
            },
            owned_by_actor: {
              type: "boolean",
              description:
                "True when the connection is the caller's own, false when another member shared it in the space.",
            },
            needs_reconnection: {
              type: "boolean",
              description:
                "True when the connection's credentials died: it is listed so the choice is complete, but a run naming it fails with `needs_reconnection` until it is reconnected.",
            },
          },
        },
        description:
          "Populated on `must_choose_connection` — every connection accessible to the caller on an auth serving the agent's selected tools, own and shared, live and dead, each carrying the fields that tell them apart. Raised when the caller owns several such connections that do not share one oauth2 account, auth and instance, or owns none and only connections shared by other members exist: a shared connection is never bound without an explicit pick. Pass the chosen `id`s back as the request body's `connection_overrides` array for that integration to retry the run. On the credential proxy the candidates are the `X-Run-Id` run's bound set (else every own and shared connection), and the retry names one in `X-Connection-Id`.",
      },
      connection_id: {
        type: "string",
        description:
          "Populated on `needs_reconnection` and `insufficient_scopes`. On `needs_reconnection`, forward it as the connect kickoff's `connection_id`, with no `scopes`, so the existing connection is reconnected in place (what it holds plus the auth's `default_scopes`) rather than duplicated. On `insufficient_scopes`, forwarding it upgrades that connection, which widens every agent that uses it; see `missing_scopes` for the least-privilege fix. Populated on `auth_serves_no_selected_tool` too, naming the connection an explicit set (pin, org default, run or schedule override) binds whose auth exposes none of the agent's selected tools: the remedy is taking it out of the set, not a connect flow.",
      },
      missing_scopes: {
        type: "array",
        items: { type: "string" },
        description:
          "Populated on `insufficient_scopes`. OAuth scopes the agent's selected tools require that the connection lacks. The least-privilege fix is a NEW connection: a connect kickoff without `connection_id`, with `scopes: required_scopes`, then bind it through the layer `source` names. When `source` is `admin_pin`, `org_default_enforced` or `schedule_override`, an admin, or the schedule's owner, must switch that binding instead.",
      },
      owned_by_actor: {
        type: "boolean",
        description:
          "Populated on `insufficient_scopes` and `needs_reconnection`. True when the connection belongs to the calling actor, who alone may reconnect or upgrade it; false for another member's shared row.",
      },
      required_scopes: {
        type: "array",
        items: { type: "string" },
        description:
          "Populated on `not_connected`, `auth_key_mismatch` and `insufficient_scopes` (never on `needs_reconnection`, whose reconnect re-consents what the connection holds plus the auth's `default_scopes`). OAuth scopes the run's selected tools require on `auth_key`. Forward as `scopes` when starting a new connection so the consent covers them.",
      },
      auth_key: {
        type: "string",
        description: `Populated on the codes a connect flow can clear (${CONNECT_FLOW_CODES.map((c) => `\`${c}\``).join(", ")}). Auth key of the integration manifest the connect flow must target (\`/auths/{authKey}/connect/...\`).`,
      },
      required_auth_key: {
        type: "string",
        description:
          "Populated on `auth_key_mismatch` and `auth_key_serves_no_selected_tool`. The agent dep's `auth_key` per AFPS §4.1. On `auth_key_serves_no_selected_tool` it names an auth that exposes none of the agent's selected tools: an agent configuration error no connection clears — the agent's `auth_key` or its tool selection must change.",
      },
      available_auth_keys: {
        type: "array",
        items: { type: "string" },
        description:
          "Populated on `auth_key_mismatch`. Auth keys the actor's existing connections use; helps the UI route to the correct connect method.",
      },
      source: {
        type: "string",
        enum: [...CONNECTION_RESOLUTION_SOURCES],
        description:
          "The cascade layer the item is about: the one whose set failed (`pinned_connection_unavailable`, `override_connection_unavailable`, `override_outranked`, and a member failing its health check — `needs_reconnection`, `insufficient_scopes`, `auth_serves_no_selected_tool`), or the one that chose `[]` (`required_integration_unbound`, `integration_unbound`). Absent when no layer bound anything.",
      },
      connect_url: {
        type: "string",
        format: "uri",
        description:
          "Ready-to-open hosted-connect link for this item. Populated only on a run-kickoff 409 or launch `warnings[]` whose caller opted in (`X-Appstrate-Connect-Offers`), and only on the items an oauth2 connect flow can clear for the calling actor (`not_connected` or `auth_key_mismatch` naming an `auth_key`, or `needs_reconnection` on a connection the actor owns, which the link reconnects in place). Never on `insufficient_scopes`. Single-use and short-lived — when present, open it instead of calling the connect kickoff, which would mint a second link.",
      },
      expiresAt: {
        type: "string",
        format: "date-time",
        description: "Absolute expiry of `connect_url` (RFC 3339).",
      },
      packageId: {
        type: "string",
        description: "Integration package id `connect_url` connects (`@scope/name`).",
      },
    },
  },
  ProblemDetail: {
    type: "object",
    description: "RFC 9457 Problem Details for HTTP APIs",
    required: ["type", "title", "status", "detail", "code", "request_id"],
    properties: {
      type: { type: "string", format: "uri", description: "URI reference to error documentation" },
      title: { type: "string", description: "Short summary of the error type" },
      status: { type: "integer", description: "HTTP status code" },
      detail: { type: "string", description: "Human-readable explanation of this occurrence" },
      instance: {
        type: "string",
        description: "URI reference identifying this specific occurrence",
      },
      code: { type: "string", description: "Machine-readable error code (snake_case)" },
      request_id: { type: "string", description: "Unique request identifier (req_ prefix)" },
      param: { type: "string", description: "Parameter that caused the error" },
      retry_after: {
        type: "integer",
        description: "Seconds before retry; mirrored in the `Retry-After` header",
      },
      errors: {
        type: "array",
        description: "Field-level validation errors",
        items: { $ref: "#/components/schemas/ResolutionFieldError" },
      },
    },
  },
  /** One `errors[]` item of a `409 missing_integration_connection`. */
  ConnectionResolutionItem: {
    allOf: [
      { $ref: "#/components/schemas/ResolutionFieldError" },
      {
        type: "object",
        properties: {
          code: { type: "string", enum: [...MISSING_INTEGRATION_CONNECTION_CODES] },
        },
      },
    ],
  },
  MissingIntegrationConnectionProblem: {
    description:
      "`missing_integration_connection`: one `errors[]` item per integration that blocks the launch (`field: integrations.<id>`).",
    allOf: [
      { $ref: "#/components/schemas/ProblemDetail" },
      {
        type: "object",
        required: ["errors"],
        properties: {
          code: { type: "string", enum: ["missing_integration_connection"] },
          errors: {
            type: "array",
            items: { $ref: "#/components/schemas/ConnectionResolutionItem" },
          },
          version_ref: {
            type: "string",
            description:
              "On every run launch refusal: the definition judged, in `Run.version_ref` terms — `draft` or a concrete semver. An omitted `version` launches the latest published version, while connection readiness reads the draft for a caller who can write the agent, so re-check readiness with `version=<version_ref>`. Absent on a schedule write, which is judged against its `version_override`.",
          },
        },
      },
    ],
  },
  ConnectionResolutionWarning: {
    description:
      "A declared, non-required integration the run starts without (its agent is told). Its `code` is the one the same state raises as a 409 item on a `required` integration, with the same fields: `not_connected` (`auth_key`, `required_scopes`, and a `connect_url` only on an agent-run or inline-run launch that sends `X-Appstrate-Connect-Offers` — never on a schedule write, a validation or a remote run), `must_choose_connection` (only other members' shared connections serve; `candidate_connections`), `auth_key_mismatch` (`required_auth_key` + `available_auth_keys`, and the `auth_key` to connect when the dep's own auth serves the selection), `integration_not_active` (switched off in the space). `integration_unbound` alone has no error twin: the layer named by `source` chose `[]`.",
    allOf: [
      { $ref: "#/components/schemas/ResolutionFieldError" },
      {
        type: "object",
        properties: {
          code: { type: "string", enum: [...CONNECTION_RESOLUTION_WARNING_CODES] },
        },
      },
    ],
  },
  // `allOf`-merged into every launch success body.
  LaunchWarnings: {
    type: "object",
    required: ["warnings"],
    properties: {
      warnings: {
        type: "array",
        description:
          "Declared, non-required integrations the run starts without. Always present. A `required` integration in the same state is a 409 instead.",
        items: { $ref: "#/components/schemas/ConnectionResolutionWarning" },
      },
    },
  },
  // The `structuredContent` of the MCP `run_and_wait` tool, and its declared `outputSchema`.
  RunAndWaitResult: {
    type: "object",
    description: `The \`run_and_wait\` MCP tool's result. \`done\` is its only discriminant: \`true\` once the run reached a terminal status, \`false\` when the wait ended first — the run is still going, and the payload carries no outcome. ${RUN_AND_WAIT_RESUME_INSTRUCTION}`,
    oneOf: [
      { $ref: "#/components/schemas/RunAndWaitPending" },
      { $ref: "#/components/schemas/RunAndWaitTerminal" },
    ],
  },
  RunAndWaitPending: {
    type: "object",
    required: RUN_AND_WAIT_REQUIRED,
    properties: { ...RUN_AND_WAIT_COMMON_PROPERTIES, done: { type: "boolean", const: false } },
    additionalProperties: false,
  },
  RunAndWaitTerminal: {
    type: "object",
    required: RUN_AND_WAIT_REQUIRED,
    properties: {
      ...RUN_AND_WAIT_COMMON_PROPERTIES,
      done: { type: "boolean", const: true },
      result: {
        description: "The run's output payload. Absent when `truncated` replaces it.",
      },
      error: { type: "string", description: "The run's own failure; never a wait outcome." },
      files: {
        type: "array",
        description: "Files the run published; absent when it published none.",
        items: {
          type: "object",
          required: ["id", "uri", "name", "mime", "size"],
          additionalProperties: false,
          properties: {
            id: { type: "string" },
            uri: { type: "string", description: "`appfile://` URI." },
            name: { type: "string" },
            mime: { type: "string" },
            size: { type: "integer", minimum: 0 },
          },
        },
      },
      truncated: {
        type: "boolean",
        const: true,
        description: `\`result\` was over ${RUN_RESULT_INLINE_MAX_BYTES} bytes of JSON: \`result_head\` holds its prefix, \`getRun\` the whole of it.`,
      },
      result_size_bytes: { type: "integer", minimum: 0 },
      result_head: { type: "string" },
      message: { type: "string", description: "How to read a truncated result." },
    },
    additionalProperties: false,
  },
  ModelGenerationSettings: {
    type: "object",
    additionalProperties: false,
    description:
      "Optional model sampling and reasoning controls. Omitted properties inherit the next lower-precedence layer.",
    properties: {
      temperature: {
        type: ["number", "null"],
        minimum: 0,
        maximum: 1,
        description:
          "Provider sampling temperature; null or omission inherits the runtime default.",
      },
      reasoning_level: {
        type: ["string", "null"],
        enum: [...MODEL_REASONING_LEVELS, null],
        description:
          "Portable reasoning effort normalized across providers; null or omission inherits the next lower-precedence layer, and `medium` applies when no layer sets one. `off` sends the provider an explicit disable.",
      },
    },
  },
  ModelCostTier: {
    type: "object",
    required: ["inputTokensAbove", "input", "output", "cacheRead", "cacheWrite"],
    description:
      "A request-wide price tier (USD per 1M tokens). When a request's input — input + cache-read + cache-write tokens — exceeds `inputTokensAbove`, the highest such tier prices the whole request. Thresholds are unique within a card.",
    properties: {
      inputTokensAbove: { type: "integer", minimum: 1 },
      input: { type: "number" },
      output: { type: "number" },
      cacheRead: { type: "number" },
      cacheWrite: { type: "number" },
    },
  },
  TokenUsage: {
    type: "object",
    additionalProperties: false,
    description:
      "Cumulative token usage in the AFPS wire format. `input_tokens` is net of cache: a request's whole prompt is `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`.",
    properties: {
      ...TOKEN_USAGE_COUNTER_PROPERTIES,
      tiers: {
        type: "array",
        description:
          "Per price tier, the share of the counters priced at it, one band per `input_tokens_above` (thresholds are unique). Absent when no request reached a tier.",
        maxItems: MAX_TOKEN_USAGE_TIERS,
        items: { $ref: "#/components/schemas/TokenUsageTier" },
      },
    },
  },
  TokenUsageTier: {
    type: "object",
    additionalProperties: false,
    required: ["input_tokens_above"],
    description:
      "The tokens of the requests priced at the tier above `input_tokens_above` — a subset of the usage's counters, which count every request. The threshold is compared to a request's whole prompt (input + cache read + cache write) and matches a rate card tier's `inputTokensAbove`; the band's counters stay net of cache.",
    properties: {
      input_tokens_above: { type: "integer", minimum: 1 },
      ...TOKEN_USAGE_COUNTER_PROPERTIES,
    },
  },
  ModelGenerationCapabilities: {
    type: "object",
    additionalProperties: false,
    required: ["temperature", "reasoning"],
    description:
      "Normalized support facts derived from the model's record in Appstrate's pinned model registry, refined by stricter provider transport declarations. A model the registry has no record of (a gateway model) takes its reasoning levels from its declared `reasoning`: `off`, `low`, `medium` and `high` when it reasons, `off` alone otherwise. `unknown` keeps temperature forward-compatible, while reasoning levels are selectable only when explicitly supported; it remains distinct from an explicit upstream refusal.",
    properties: {
      temperature: { type: "string", enum: [...modelCapabilitySupportSchema.options] },
      reasoning: {
        type: "object",
        additionalProperties: false,
        required: ["supported", "adaptive", "levels"],
        properties: {
          supported: { type: "string", enum: [...modelCapabilitySupportSchema.options] },
          temperature_compatible: {
            type: "string",
            enum: [...modelCapabilitySupportSchema.options],
            description:
              "Optional compatibility fact for combining a custom temperature with active reasoning. Omission means unknown.",
          },
          adaptive: { type: ["boolean", "null"] },
          levels: {
            type: "object",
            additionalProperties: {
              type: "string",
              enum: [...modelCapabilitySupportSchema.options],
            },
            propertyNames: {
              enum: [...MODEL_REASONING_LEVELS],
            },
          },
          off: {
            type: "string",
            enum: [...MODEL_REASONING_OFF_BEHAVIOURS],
            description:
              "What level `off` puts on the wire. `disables`: an explicit reasoning-off parameter. `unsent`: no reasoning parameter, so the server keeps its own default and some models still reason. Absent when the model does not reason, does not take `off`, or when what it sends is not known. An alias never reports it: it would identify the backing model.",
          },
        },
      },
    },
  },
  User: {
    type: "object",
    // Better-Auth-owned shape: the platform documents the three fields it
    // relies on, but Better Auth also emits emailVerified/image/createdAt/
    // updatedAt (+ the platform `realm` column). The SPA reads the user via the
    // Better Auth client, not the generated OpenAPI type, so the full set is
    // framework-owned — declare the response open rather than mirror an
    // upstream shape that changes on Better Auth upgrades.
    additionalProperties: true,
    required: ["id", "name", "email"],
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      email: { type: "string" },
    },
  },
  SpacePackage: {
    type: "object",
    description:
      "A package PLACED in a space, with `enabled` and its model/proxy overrides. The row survives deactivation — every setting on it is kept — and goes away only when the placement behind it is withdrawn: the share is revoked (`DELETE /api/packages/{scope}/{name}/shares/{target}`), or the package's home moves out of the space with `keep_in_previous_home: false`. It carries no version: outside its home space a package runs its latest published version, and its draft runs for whoever can write it.",
    // The spacePackageSelect projection emits every field unconditionally
    // (package_type/package_source come from the join). `object` is spec-only
    // (not on the SpacePackage shared type). Stored input values and their locks
    // are not here — they are read via `GET /api/agents/{scope}/{name}`
    // (`AgentDetail.input`), where the schema and the locks travel with them.
    //
    // CASING: this object deliberately mixes cases and the spec matches the
    // runtime serializer (`services/space-packages.ts:spacePackageSelect`)
    // field-for-field — spec==runtime is the hard invariant, so do NOT "normalize".
    //   - `packageId`/`modelId`/`proxyId`/`updatedAt` are camelCase per the
    //     universal *Id / timestamp carve-out (docs/CASING_CONVENTIONS.md).
    //   - `installed_at` is snake_case: the projection aliases the COLUMN of
    //     that name, so it DIVERGES from the timestamp carve-out. Documented
    //     module carve-out, and the one place the activation vocabulary does
    //     not reach — the column is data, renamed by a migration or not at all.
    required: [
      "packageId",
      "generation_config",
      "modelId",
      "proxyId",
      "enabled",
      "chat_enforced",
      "installed_at",
      "updatedAt",
      "package_type",
      "package_source",
      "draft_manifest",
    ],
    properties: {
      object: { type: "string", enum: ["space_package"] },
      packageId: { type: "string", description: "Package ID from org catalog" },
      generation_config: {
        oneOf: [{ $ref: "#/components/schemas/ModelGenerationSettings" }, { type: "null" }],
      },
      modelId: { type: ["string", "null"], description: "Model override for this space" },
      proxyId: { type: ["string", "null"], description: "Proxy override for this space" },
      enabled: { type: "boolean" },
      chat_enforced: {
        type: "boolean",
        description:
          "Skills only: while the skill is active here, its latest published `SKILL.md` is injected in every chat conversation held in this space, whatever the member's `skills:*` grants. Kept across deactivation. Always `false` for other types.",
      },
      installed_at: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
      package_type: { type: "string", enum: [...packageTypeValues] },
      package_source: { type: "string", enum: [...packageSourceValues] },
      draft_manifest: {
        type: ["object", "null"],
        description: "Raw draft manifest JSONB for the placed package.",
      },
    },
  },
  // READ shape — deliberately open, see ORG_SETTINGS_PROPERTIES above. The
  // write body of PATCH /api/orgs/{orgId}/settings is the closed twin.
  OrgSettings: {
    type: "object",
    description: "Organization settings (extensible)",
    properties: ORG_SETTINGS_PROPERTIES,
  },
  ProfileBatchItem: {
    type: "object",
    required: ["id"],
    properties: {
      id: { type: "string" },
      // Nullable: `profiles.display_name` has no NOT NULL constraint, so a
      // member who never set a display name serializes `null` here. Mirrors
      // the sibling `UserProfile.displayName`.
      displayName: { type: ["string", "null"] },
    },
  },
  UserProfile: {
    type: "object",
    description:
      "The dashboard user's profile — single serializer shared by GET and PATCH /api/profile.",
    required: ["id", "language", "email", "name", "can_create_org"],
    properties: {
      id: { type: "string" },
      displayName: { type: ["string", "null"] },
      language: { type: "string", enum: ["fr", "en"] },
      email: { type: "string", format: "email" },
      name: { type: "string" },
      can_create_org: {
        type: "boolean",
        description:
          "Whether `POST /api/orgs` would accept this user: true on an open instance, and for platform admins alone when organization creation is disabled (`AUTH_DISABLE_ORG_CREATION`).",
      },
    },
  },
  Organization: {
    type: "object",
    required: ["id", "name", "slug", "role", "permissions", "createdAt", "deleting_at"],
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      slug: { type: "string" },
      role: { type: "string", enum: ORG_ROLES },
      permissions: {
        type: "array",
        items: { type: "string" },
        description:
          "The caller's ORG-LEVEL effective permissions in this organization: what the role grants, narrowed by the credential's ceiling (an API key's scopes, an OIDC scope claim). Space-level permissions are answered per space by GET /api/spaces.",
      },
      createdAt: { type: "string", format: "date-time", description: "Creation timestamp" },
      deleting_at: {
        type: ["string", "null"],
        format: "date-time",
        description:
          "When this organization's deletion was reserved, or null. Non-null on an organization that still exists means a DELETE was interrupted after the reservation; repeating the DELETE is the recovery.",
      },
    },
  },
  OrgMember: {
    type: "object",
    // `email`/`displayName` are best-effort joins (getOrgMembers emits
    // `?? undefined` when the user/profile row is missing) — NOT required.
    required: ["userId", "role", "joinedAt"],
    properties: {
      userId: { type: "string" },
      displayName: { type: "string" },
      email: { type: "string" },
      role: { type: "string", enum: ORG_ROLES },
      joinedAt: { type: "string", format: "date-time" },
    },
  },
  SpaceAssignment: {
    type: "object",
    description:
      "A space membership the invitation applies when it is accepted. Exactly one of `preset_role` / `custom_role_id` is set.",
    required: ["spaceId"],
    oneOf: [{ required: ["preset_role"] }, { required: ["custom_role_id"] }],
    properties: {
      spaceId: { type: "string" },
      preset_role: { type: "string", enum: [...SPACE_ROLE_PRESETS] },
      custom_role_id: { type: "string", pattern: SPACE_ROLE_ID_PATTERN },
    },
    additionalProperties: false,
  },
  OrgInvitationInfo: {
    type: "object",
    required: ["id", "email", "role", "space_assignments", "token", "expiresAt", "createdAt"],
    properties: {
      id: { type: "string" },
      email: { type: "string" },
      role: { type: "string", enum: ORG_ROLES },
      space_assignments: {
        type: "array",
        items: { $ref: "#/components/schemas/SpaceAssignment" },
        description: "Space memberships applied when the invitation is accepted.",
      },
      token: { type: "string" },
      expiresAt: { type: "string", format: "date-time" },
      createdAt: { type: "string", format: "date-time" },
    },
  },
  OrgDetail: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      slug: { type: "string" },
      createdAt: { type: "string", format: "date-time" },
      deleting_at: {
        type: ["string", "null"],
        format: "date-time",
        description:
          "When this organization's deletion was reserved, or null. Non-null on an organization that still exists means a DELETE was interrupted after the reservation; repeating the DELETE is the recovery.",
      },
      storage: {
        type: "object",
        description:
          "Durable-file storage consumption for this organization. `used_bytes` is the running total of stored file bytes; `limit_bytes` is the raw per-org limit override (`files_bytes_limit`), or null when no override is set; `effective_limit_bytes` is the limit the write path enforces — the override, else the global quota (`ORG_STORAGE_QUOTA_BYTES`), else null (unlimited).",
        required: ["used_bytes", "limit_bytes", "effective_limit_bytes"],
        properties: {
          used_bytes: { type: "integer", description: "Bytes of durable files stored." },
          limit_bytes: {
            type: ["integer", "null"],
            description:
              "Per-org limit override in bytes, or null when no override is set (falls back to the global quota).",
          },
          effective_limit_bytes: {
            type: ["integer", "null"],
            description:
              "Effective limit in bytes the write path enforces (override ?? global quota), or null when unlimited.",
          },
        },
      },
      members: {
        type: "array",
        items: { $ref: "#/components/schemas/OrgMember" },
        description: "Empty unless the caller holds members:read.",
      },
      invitations: {
        type: "array",
        items: { $ref: "#/components/schemas/OrgInvitationInfo" },
        description:
          "Empty unless the caller holds members:invite, including any credential scope ceiling.",
      },
    },
  },
  AgentSkillRef: {
    type: "object",
    required: ["id", "home_writable"],
    properties: {
      id: { type: "string" },
      version: { type: "string" },
      name: { type: "string" },
      description: { type: "string" },
      home_writable: {
        type: "boolean",
        description:
          'Whether THIS caller holds the skill\'s `skills:write` in its home space — i.e. whether its DRAFT is theirs to run. A launch may opt one dependency into its working copy with `dependency_overrides: { "@scope/skill": "draft" }`, and the run routes answer `403 draft_not_writable` when this is false, so a client offers that option only where it is true. Always emitted.',
      },
    },
  },
  AgentListItem: {
    type: "object",
    // `running_runs`/`dependencies`/`scope`/`keywords`/`version` are always
    // emitted by the GET /api/agents mapper. `display_name`/`description`/
    // `schema_version`/`author` stay optional (manifest-derived, may be absent);
    // `forked_from` is not emitted by the list endpoint (shared-type optional).
    // There is no `active`: the listing IS the active set, so the field could
    // only ever say `true` — `AgentDetail.active` is where the switch is read.
    required: [
      "id",
      "source",
      "type",
      "running_runs",
      "dependencies",
      "scope",
      "keywords",
      "version",
    ],
    properties: {
      id: { type: "string" },
      display_name: { type: "string" },
      description: { type: "string" },
      schema_version: { type: "string" },
      author: { type: "string" },
      keywords: { type: "array", items: { type: "string" } },
      source: { type: "string", enum: [...packageSourceValues] },
      scope: {
        type: ["string", "null"],
        description:
          "Scope from manifest name, including the leading `@` (e.g. `@myorg` from `@myorg/name`). Directly usable as the `{scope}` path parameter of package/agent operations.",
      },
      version: { type: ["string", "null"], description: "Version from manifest" },
      type: {
        type: "string",
        description: "Package type from manifest",
        enum: [...packageTypeValues],
      },
      running_runs: { type: "integer" },
      dependencies: {
        type: "object",
        // `integrations` — which SaaS the agent talks to — is emitted to every
        // caller; a launcher is the one who connects them. `skills` and
        // `mcp_servers` are the composition, withheld from a summary read
        // (`agents:run` without `agents:read`) and absent rather than empty.
        required: ["integrations"],
        properties: {
          skills: {
            type: "object",
            additionalProperties: { type: "string" },
            description: "Withheld from a summary read (`agents:run` without `agents:read`).",
          },
          mcp_servers: {
            type: "object",
            additionalProperties: { type: "string" },
            description: "Withheld from a summary read (`agents:run` without `agents:read`).",
          },
          integrations: { type: "object", additionalProperties: { type: "string" } },
        },
      },
    },
  },
  // Composition base (AgentDetail.input, the run-config response) AND the
  // response body of PUT /agents/{scope}/{name}/input-settings. Left OPEN on
  // purpose — see AGENT_INPUT_SETTINGS_PROPERTIES above; that route's REQUEST
  // body is the closed twin, spelled in openapi/paths/agents.ts.
  AgentInputSettings: {
    type: "object",
    required: ["values", "locked_fields"],
    description:
      "The agent's stored input settings for one space: the values the editor set once (layer 2 of the input resolution) and the fields it froze. Both are full replacements — an omitted key means cleared, never unchanged.",
    properties: AGENT_INPUT_SETTINGS_PROPERTIES,
  },
  AgentDetail: {
    type: "object",
    // Always emitted by buildAgentDetailDto. `display_name`/`description`/
    // `updatedAt` stay optional: system agents omit `updatedAt`,
    // and the manifest-derived display_name/description may be absent (the
    // shared-type marks them optional to match). `forked_from` is optional for
    // a second reason: a summary read (`agents:run` without `agents:read`)
    // withholds the authoring history along with the manifest and the prompt.
    // The home group (`home_space_id`/`home_writable`/`home_deletable`/
    // `home_shareable`) is NOT part of that withheld set: a summary read still
    // has to know it may not edit, and an absent boolean would read as "not
    // answered yet" rather than "no".
    required: [
      "id",
      "source",
      "scope",
      "version",
      "definition",
      "dependencies",
      "input",
      "running_runs",
      "last_run",
      "effective_timeout_seconds",
      "active",
      "home_space_id",
      "home_writable",
      "home_deletable",
      "home_shareable",
    ],
    properties: {
      id: { type: "string" },
      display_name: { type: "string" },
      description: { type: "string" },
      source: { type: "string", enum: [...packageSourceValues] },
      scope: {
        type: ["string", "null"],
        description:
          "Scope from manifest name, including the leading `@` (e.g. `@myorg`). Directly usable as the `{scope}` path parameter of package/agent operations.",
      },
      version: { type: ["string", "null"], description: "Version from manifest" },
      definition: {
        type: "string",
        enum: ["draft", "published"],
        description:
          'WHICH definition every manifest-derived field here was projected from: `draft` is the author\'s working copy, `published` a `package_versions` snapshot (the `latest` one, or the version `?version=` named). With no selector: the draft for a caller who may WRITE the agent, otherwise the latest published version, and — when nothing is published — the draft in read-only, because a package the listing shows must have a page. `definition: "draft"` together with `home_writable: false` is therefore the pair that means "never published, you are seeing the author\'s work in progress": a launch with no selector will answer `404 no_published_version`, so a client disables it and says why rather than offering a button that cannot work.',
      },
      manifest: {
        allOf: [{ $ref: "#/components/schemas/AgentManifest" }],
        description: "Full manifest object (user agents only)",
      },
      prompt: { type: "string", description: "Agent prompt markdown (user agents only)" },
      updatedAt: {
        type: "string",
        format: "date-time",
        description: "Last updated timestamp (user agents only)",
      },
      input: {
        // Stated explicitly alongside `allOf`: the branches below are a
        // conjunction on an object, and a reader that stops at the top level
        // (openapi-typescript, the breaking-change detector) must still see it.
        type: "object",
        // `values` + `locked_fields` are NOT re-spelled here: they are the
        // AgentInputSettings component, which is also the request and response
        // body of PUT /agents/{scope}/{name}/input-settings. Spelling them
        // twice is how `locked_fields` ended up documented as the full rule in
        // one place and a single clause in the other.
        allOf: [
          { $ref: "#/components/schemas/AgentInputSettings" },
          {
            type: "object",
            // The detail serializer always emits `schema` (falls back to an
            // empty object schema when the manifest declares no input wrapper),
            // on top of the two per-space layers the launch form needs.
            required: ["schema"],
            properties: {
              schema: { type: "object", description: "Pure JSON Schema 2020-12 object" },
              file_constraints: { $ref: "#/components/schemas/FileConstraintsMap" },
              ui_hints: { $ref: "#/components/schemas/UIHintsMap" },
              property_order: {
                type: "array",
                items: { type: "string" },
                description: "Presentation order for schema properties",
              },
            },
          },
        ],
        description:
          "AFPS schema wrapper for the agent's parameters, plus the per-space stored values and field locks. Resolution order at launch: author default (JSON Schema `default`) < stored value (`values`) < schedule value < caller input. A field named in `locked_fields` is not asked at launch and a caller that sets it is refused with 400 `locked_input_field`. A summary read (`agents:run` without `agents:read`) still receives every locked field's NAME, but `values` carries no entry for one — a field the launcher cannot set is not one it reads the stored value of.",
      },
      output: {
        type: "object",
        description: "AFPS schema wrapper for per-run output.",
        properties: {
          schema: { type: "object", description: "Pure JSON Schema 2020-12 object" },
          property_order: {
            type: "array",
            items: { type: "string" },
            description: "Presentation order for schema properties",
          },
        },
      },
      dependencies: {
        type: "object",
        // `integrations` (via parseManifestIntegrations) is emitted to every
        // caller — a launcher is the one who connects them. `skills` and
        // `mcp_servers`, the composition, are withheld from a summary read
        // (`agents:run` without `agents:read`) and absent rather than empty.
        required: ["integrations"],
        properties: {
          skills: {
            type: "array",
            items: { $ref: "#/components/schemas/AgentSkillRef" },
            description: "Withheld from a summary read (`agents:run` without `agents:read`).",
          },
          mcp_servers: {
            type: "array",
            items: {
              type: "object",
              required: ["id", "version"],
              properties: {
                id: { type: "string" },
                version: { type: "string" },
              },
            },
            description:
              "AFPS §4.1 mcp_servers dependency group. Withheld from a summary read (`agents:run` without `agents:read`).",
          },
          integrations: {
            type: "array",
            items: {
              type: "object",
              required: ["id", "version"],
              properties: {
                id: { type: "string" },
                version: { type: "string" },
                tools: {
                  oneOf: [
                    { type: "array", items: { type: "string" } },
                    { type: "string", enum: ["*"] },
                  ],
                  description:
                    "Niveau 2 tool allowlist (optional). Either an array of selected tool names or the AFPS §4.4 wildcard literal '*' opting the agent into every upstream tool (requires integration's `allow_undeclared_tools: true`).",
                },
                scopes: {
                  type: "array",
                  items: { type: "string" },
                  description: "Niveau 2 explicit scope escape hatch (optional)",
                },
                auth_key: {
                  type: "string",
                  description:
                    "AFPS §4.4 — which of the integration's `auths` the agent uses (optional; absent lets any serving auth bind).",
                },
                required: {
                  type: "boolean",
                  description:
                    "AFPS §4.4 — `true`: a run refuses to start unless a connection binds. Absent or `false`: the run starts without it, reported in the launch response's `warnings`.",
                },
              },
            },
          },
        },
      },
      last_run: {
        type: ["object", "null"],
        description: "Summary of the most recent run (null if never run)",
        // When present, the serializer always sets all four (id/status/started_at
        // are NOT NULL columns; duration is nullable but always emitted).
        required: ["id", "status", "started_at", "duration"],
        properties: {
          id: { type: "string" },
          status: { type: "string" },
          started_at: { type: "string", format: "date-time" },
          duration: { type: ["integer", "null"] },
        },
      },
      running_runs: { type: "integer" },
      version_count: {
        type: "integer",
        description: "Number of published versions (0 for built-in agents)",
      },
      forked_from: { type: ["string", "null"], description: "Source package ID if forked" },
      ...PACKAGE_HOME_PROPERTIES,
      has_unarchived_changes: {
        type: "boolean",
        description: "Whether the active version has changes not yet archived as a version",
      },
      effective_timeout_seconds: {
        type: "integer",
        description:
          "Run timeout that will actually be enforced, in seconds: the manifest's `timeout` (or the platform default when it declares none) clamped to this deployment's `PLATFORM_RUN_LIMITS.timeout_ceiling_seconds`. Compare with `manifest.timeout` to detect a capped declaration. Emitted for system agents too, which do not expose `manifest`.",
      },
      active: {
        type: "boolean",
        description:
          "Whether the agent is ACTIVE in the space this detail was read from — the placement row's `enabled` where the package is placed here, the deployment's default where the space holds no row. Answered by the detail itself so a loaded page needs no second call. READING an agent never requires it to be active, which is why this endpoint answers 200 on `active: false` while `POST …/run`, `POST …/schedules` and `GET …/bundle` answer `404 agent_not_active_in_space`. The agents INDEX carries no such field — it lists the active set — so a page that must render an inactive agent reaches it from the space library. Always emitted.",
      },
    },
  },
  AgentVersion: {
    type: "object",
    required: ["id", "version", "integrity", "artifact_size", "yanked", "created_by", "createdAt"],
    properties: {
      id: { type: "integer" },
      packageId: { type: "string" },
      version: { type: "string", description: "Semver version string (e.g. 1.0.0)" },
      integrity: { type: "string", description: "SRI integrity hash (sha256-...)" },
      artifact_size: { type: "integer", description: "Artifact ZIP size in bytes" },
      yanked: { type: "boolean", description: "Whether this version has been yanked" },
      created_by: { type: ["string", "null"] },
      createdAt: { type: ["string", "null"], format: "date-time" },
    },
  },
  // Canonical version detail DTO — the exact shape the `GET .../versions/{version}`
  // endpoints serialize (the per-type GET detail uses a type-specific manifest
  // `$ref`; this generic form is reused by the version create/restore mutation
  // responses so they echo the resulting version resource — issue #646).
  PackageVersionDetail: {
    type: "object",
    required: [
      "id",
      "version",
      "manifest",
      "integrity",
      "artifact_size",
      "yanked",
      "yanked_reason",
      "createdAt",
      "dist_tags",
    ],
    properties: {
      id: { type: "integer", description: "Version row id" },
      version: { type: "string", description: "Semver version string (e.g. 1.0.0)" },
      manifest: {
        type: "object",
        additionalProperties: true,
        description: "Full version manifest (AFPS)",
      },
      content: {
        type: ["string", "null"],
        description: "Primary content file extracted from the version ZIP",
      },
      yanked: { type: "boolean", description: "Whether this version has been yanked" },
      yanked_reason: { type: ["string", "null"] },
      integrity: { type: "string", description: "SRI integrity hash (sha256-...)" },
      artifact_size: { type: "integer", description: "Artifact ZIP size in bytes" },
      createdAt: { type: ["string", "null"], format: "date-time" },
      dist_tags: { type: "array", items: { type: "string" } },
    },
  },
  // One real file in a package artifact. The index is FLAT — directories are
  // not synthesized; a client derives the tree from the `path` values.
  PackageFileEntry: {
    type: "object",
    required: ["path", "size", "media_kind"],
    properties: {
      path: {
        type: "string",
        description: "Path inside the artifact, relative and normalized (e.g. `skills/a/SKILL.md`)",
      },
      size: { type: "integer", description: "Uncompressed size in bytes" },
      media_kind: {
        type: "string",
        enum: ["text", "binary"],
        description:
          "`text` when the file decodes as strict UTF-8 (files above the 1 MiB inline ceiling are classified by extension instead, since they can never be previewed).",
      },
      inline: {
        type: "string",
        description:
          "Full decoded text, present only for `text` files at most 1 MiB that still fit the response's cumulative inline budget. NEVER truncated: when absent, fetch the file from `GET /api/packages/{scope}/{name}/files/content`.",
      },
    },
  },
  PackageFileIndex: {
    type: "object",
    required: ["object", "data", "hasMore"],
    properties: {
      object: { type: "string", enum: ["list"] },
      data: {
        type: "array",
        items: { $ref: "#/components/schemas/PackageFileEntry" },
        description: "Files in the artifact, sorted by `path`.",
      },
      hasMore: {
        type: "boolean",
        description: "Always `false`: the index is never paginated.",
      },
    },
  },
  // The three edits a draft-tree batch is made of. Named rather than inline so
  // `PackageFileWriteOperation`'s discriminator can actually select one — a
  // discriminator over inline branches selects nothing.
  PackageFileWriteEntry: {
    type: "object",
    required: ["op", "path"],
    additionalProperties: false,
    properties: {
      op: { type: "string", const: "write" },
      path: {
        type: "string",
        minLength: 1,
        maxLength: 1024,
        description:
          "Archive-relative path to write. Creates the entry or replaces it; parent directories are implicit (a path is just a name containing `/`).",
      },
      text: {
        type: "string",
        description:
          "File content, stored as its UTF-8 encoding. Mutually exclusive with `bytes_base64`; exactly one of the two is required.",
      },
      bytes_base64: {
        type: "string",
        description:
          "File content as standard base64 (URL-safe base64 is refused). Mutually exclusive with `text`; exactly one of the two is required.",
      },
    },
  },
  PackageFileDeleteEntry: {
    type: "object",
    required: ["op", "path"],
    additionalProperties: false,
    properties: {
      op: { type: "string", const: "delete" },
      path: {
        type: "string",
        minLength: 1,
        maxLength: 1024,
        description: "Entry to remove. A path the tree does not hold is a `404`.",
      },
    },
  },
  PackageFileMoveEntry: {
    type: "object",
    required: ["op", "from", "to"],
    additionalProperties: false,
    properties: {
      op: { type: "string", const: "move" },
      from: {
        type: "string",
        minLength: 1,
        maxLength: 1024,
        description: "Entry to rename. A path the tree does not hold is a `404`.",
      },
      to: {
        type: "string",
        minLength: 1,
        maxLength: 1024,
        description:
          "New path. A move NEVER overwrites: a destination that is already taken is a `400 path_conflict`, so a rename cannot carry off a file the operation does not name. To replace, `delete` the destination earlier in the same batch.",
      },
    },
  },
  // One edit to a draft file tree. The batch applies these IN ORDER, so a
  // `move` followed by a `write` on the new path is one request.
  PackageFileWriteOperation: {
    oneOf: [
      { $ref: "#/components/schemas/PackageFileWriteEntry" },
      { $ref: "#/components/schemas/PackageFileDeleteEntry" },
      { $ref: "#/components/schemas/PackageFileMoveEntry" },
    ],
    discriminator: {
      propertyName: "op",
      mapping: {
        write: "#/components/schemas/PackageFileWriteEntry",
        delete: "#/components/schemas/PackageFileDeleteEntry",
        move: "#/components/schemas/PackageFileMoveEntry",
      },
    },
  },
  Run: {
    type: "object",
    // Every field a run response carries unconditionally. The list/detail/
    // create handlers all route through `mapEnrichedRun` (services/state/runs.ts),
    // so the enriched join fields (`user_name`, `connections_used`, …) are as
    // guaranteed as the base columns. Only `inline_manifest` / `inline_prompt`
    // are detail-only (added by `getRunFull`) and stay optional. Keeping this
    // list exhaustive lets the SPA consume the generated `Run` type with no
    // cast and lets verify-openapi step 7 guard it against `EnrichedRun` drift.
    required: [
      "id",
      "packageId",
      "userId",
      "endUserId",
      "apiKeyId",
      "orgId",
      "spaceId",
      "scheduleId",
      "status",
      "input",
      "result",
      "artifacts",
      "checkpoint",
      "error",
      "metadata",
      "generation",
      "generation_override",
      "started_at",
      "completed_at",
      "duration",
      "cost",
      "cost_pricing_status",
      "runNumber",
      "token_usage",
      "version_label",
      "version_ref",
      "proxy_label",
      "model_label",
      "model_source",
      "runner_name",
      "runner_kind",
      "agent_scope",
      "agent_name",
      "runOrigin",
      "contextSnapshot",
      "modelCredentialId",
      "connection_overrides",
      "dependency_overrides",
      "user_name",
      "end_user_name",
      "api_key_name",
      "schedule_name",
      "connections_used",
      "integrations_unbound",
      "package_ephemeral",
      "unread",
      "file_counts",
    ],
    properties: {
      id: { type: "string" },
      packageId: {
        type: ["string", "null"],
        description:
          "Source agent ID. NULL when the source agent has been deleted — the run row survives via `runs.package_id ON DELETE SET NULL` (migration 0017). Read `agent_scope` / `agent_name` for display in that case; re-running is not possible.",
      },
      userId: {
        type: ["string", "null"],
        description: "Dashboard user ID that triggered the run (null for end-user/schedule runs)",
      },
      orgId: { type: "string" },
      status: {
        type: "string",
        enum: [...runStatusValues],
      },
      input: {
        type: ["object", "null"],
        additionalProperties: true,
        description:
          "Resolved run input. Registered-agent input is null without agents:read because it can contain editor-imposed values, including historical locks. Inline input remains visible. Execution and rerun retain the complete input server-side.",
      },
      result: {
        type: ["object", "null"],
        description:
          "What the run produced: the structured output, and nothing else. Human-facing deliverables are files (see the run's files), not fields here. `null` while the run is in flight or when no output was emitted.",
        properties: {
          output: {
            description:
              "Structured JSON emitted via the agent's `output` runtime tool. Validated against the agent's declared output schema when one exists — a schema mismatch flips the run to `failed` (with the validation errors in `error`) but the payload is still stored, never dropped.",
          },
        },
      },
      artifacts: {
        type: ["object", "null"],
        description:
          "Terminal summary of the run's end-of-run `outputs/` sweep. `status: \"partial\"` means at least one deliverable was LOST (upload abandoned after retries, or a file over the per-file cap); `failed` lists each lost file's name + a stable code (`file_too_large`, `quota_exceeded`, `conflict`, `upload_failed`). Independent of the run `status` — a successful run can still be `partial`. Null on older runs / containers that never reported it.",
        required: ["status", "published", "failed"],
        properties: {
          status: { type: "string", enum: ["complete", "partial"] },
          published: {
            type: "integer",
            minimum: 0,
            description: "Count of deliverables the sweep published to durable storage.",
          },
          failed: {
            type: "array",
            description: "Deliverables the sweep could not publish (lost).",
            items: {
              type: "object",
              required: ["name", "code"],
              properties: {
                name: {
                  type: "string",
                  description: "Workspace-relative path of the lost file under `outputs/`.",
                },
                code: {
                  type: "string",
                  description:
                    "Stable failure category: `file_too_large`, `quota_exceeded`, `conflict`, or `upload_failed`.",
                },
              },
            },
          },
        },
      },
      // `runs.checkpoint` is a nullable jsonb column — null on every run that
      // never emitted a checkpoint (pending/running/most terminal runs).
      checkpoint: { type: ["object", "null"], additionalProperties: true },
      error: { type: ["string", "null"] },
      token_usage: {
        description:
          "Snapshot of token consumption for the run, as every runner (PiRunner / remote CLI / GitHub Action) reports it, parsed on ingestion before it is stored. `null` until the run reports usage.",
        oneOf: [{ $ref: "#/components/schemas/TokenUsage" }, { type: "null" }],
      },
      started_at: { type: ["string", "null"], format: "date-time" },
      completed_at: { type: ["string", "null"], format: "date-time" },
      duration: { type: ["integer", "null"], description: "Duration in milliseconds" },
      scheduleId: { type: ["string", "null"] },
      version_label: {
        type: ["string", "null"],
        description:
          "Version label at run time (e.g. '1.0.0'). For draft runs this is the latest published version the draft sits on top of — read `version_ref` to know which definition actually executed.",
      },
      version_ref: {
        type: "string",
        description:
          "Unambiguous reference to the agent definition the run executed: 'draft' when the mutable draft ran with unpublished changes (or the agent has no published version), or the concrete semver (e.g. '2.1.0') when the run executed that published definition (or a draft identical to it).",
      },
      proxy_label: { type: ["string", "null"], description: "Proxy label used at run time" },
      model_label: { type: ["string", "null"], description: "Model label used at run time" },
      model_source: {
        type: ["string", "null"],
        enum: [...credentialSourceValues, null],
        description:
          "Model source: 'system' (platform-provided) or 'org' (user-configured). Resolved at run creation — an org-default change between triggers applies to subsequent runs unless the run was pinned via the runAgent `modelId` override. `null` on a remote-origin run (its runner brings its own model) and on a run refused before launch.",
      },
      cost: { type: ["number", "null"], description: "Run cost in USD" },
      cost_pricing_status: {
        type: ["string", "null"],
        enum: ["priced", "partial", "unpriced", null],
        description:
          'How much of `cost` is backed by real per-token rates. `priced`: every token bucket that carried usage had a rate, so the figure is complete. `partial`: part of the consumption (cached input) had no rate and was priced at zero, so the figure is a FLOOR, not the full amount. `unpriced`: no rates were available for the model at all — a `cost` of 0 alongside this value means "not priced", NOT "free"; do not bill or display it as zero spend. `null` on runs finalized before this field existed and on runs that produced no usage rows; never read `null` as `priced`.',
      },
      endUserId: {
        type: ["string", "null"],
        description: "End-user ID (eu_ prefix) if executed on behalf of an end-user",
      },
      apiKeyId: {
        type: ["string", "null"],
        description: "API key ID that triggered the run (null for dashboard/schedule runs)",
      },
      spaceId: {
        type: "string",
        pattern: SPACE_ID_RE.source,
        description: "Space ID (spc_ prefix) that owns this run",
      },
      metadata: {
        type: ["object", "null"],
        description:
          "Additional module-supplied metadata (e.g. usage-metering fields written by an optional module). Free-form; core does not define billing-specific keys.",
        additionalProperties: true,
      },
      generation: {
        oneOf: [{ $ref: "#/components/schemas/ModelGenerationSettings" }, { type: "null" }],
        description: "Effective generation controls resolved and frozen when the run was created.",
      },
      generation_override: {
        oneOf: [{ $ref: "#/components/schemas/ModelGenerationSettings" }, { type: "null" }],
        description: "Raw per-invocation generation layer, before agent defaults are applied.",
      },
      user_name: {
        type: ["string", "null"],
        description:
          "Display name of the dashboard user who triggered the run (from profiles table)",
      },
      end_user_name: {
        type: ["string", "null"],
        description: "Display name of the end-user (name or externalId fallback)",
      },
      api_key_name: {
        type: ["string", "null"],
        description: "Name of the API key that triggered the run",
      },
      schedule_name: {
        type: ["string", "null"],
        description: "Name of the schedule that triggered the run",
      },
      runner_name: {
        type: ["string", "null"],
        description:
          "Human-friendly label for the runner that triggered the run — CLI host (`os.hostname()`), GitHub Action workflow, or whatever the caller passes via `X-Appstrate-Runner-Name`. Stamped at INSERT and never updated.",
      },
      runner_kind: {
        type: ["string", "null"],
        description:
          "Free-form classifier driving the dashboard icon (`cli`, `github-action`, …). Sourced from `X-Appstrate-Runner-Kind` or inferred from the auth context.",
      },
      agent_scope: {
        type: ["string", "null"],
        description:
          "Denormalized agent scope at run creation, including the leading `@` (e.g. `@myorg`). Survives rename, delete, or shadow compaction — the global run view falls back to this when the source package is gone.",
      },
      agent_name: {
        type: ["string", "null"],
        description: "Denormalized agent name at run creation (see agent_scope).",
      },
      package_ephemeral: {
        type: "boolean",
        description:
          "Present on enriched run responses. True when the source package is an inline-run shadow (POST /api/runs/inline).",
      },
      file_counts: {
        type: "object",
        description:
          "Per-run file counts, always present on enriched list responses. Computed server-side: `input` from the distinct `appfile://` references in the run's persisted input, `output` from the count of files the run produced.",
        required: ["input", "output"],
        properties: {
          input: {
            type: "integer",
            minimum: 0,
            description: "Distinct files referenced as input by the run.",
          },
          output: {
            type: "integer",
            minimum: 0,
            description: "Files produced by the run.",
          },
        },
      },
      inline_manifest: {
        type: ["object", "null"],
        description:
          "Inline runs only. Snapshot of the manifest submitted at run time. Null once the shadow has been compacted (see INLINE_RUN_LIMITS.retention_days).",
        additionalProperties: true,
      },
      inline_prompt: {
        type: ["string", "null"],
        description:
          "Inline runs only. Snapshot of the prompt submitted at run time. Null once the shadow has been compacted.",
      },
      unread: {
        type: "boolean",
        description:
          "True when the requesting recipient has an unread notification for this run (issue #667). Per-recipient: derived from the notifications table for the current actor, so a dashboard user and an end-user see independent state. Drives the unread dot on run rows and the per-schedule unread count.",
      },
      runNumber: {
        type: ["integer", "null"],
        description:
          "Per-(app, package) monotonic counter assigned at run creation. Stable identifier for UI display.",
      },
      // CASING: `runOrigin`/`contextSnapshot` are camelCase on the wire even
      // though they are neither *Id nor timestamp fields (the general rule would
      // make them `run_origin`/`context_snapshot`). This is a documented module
      // carve-out: the run serializer (`services/state/runs.ts`) emits the camel
      // keys verbatim from the Drizzle model, so the spec matches the runtime
      // (spec==runtime invariant). Do not rename without changing the serializer.
      runOrigin: {
        type: ["string", "null"],
        enum: [...runOriginValues, null],
        description:
          "Which runner drives this run: 'platform' (server-managed Docker container) or 'remote' (caller's host via signed events).",
      },
      contextSnapshot: {
        type: ["object", "null"],
        description:
          "Runner-provided execution environment metadata (os, cli version, git sha, ...) stamped at run creation.",
        additionalProperties: true,
      },
      modelCredentialId: {
        type: ["string", "null"],
        description:
          "ID of the model_provider_credentials row resolved at run creation (audit + cost-attribution).",
      },
      connection_overrides: {
        type: ["object", "null"],
        description: `Per-integration connection picks for this run (cascade layer 3, the launch override). Map of sets: \`{ "@scope/integration": ["<connection_id>", ...] }\` — 0..${MAX_CONNECTIONS_PER_INTEGRATION} connections per integration (\`[]\` = none, see the set schema); each chosen connection carries its own authKey. Loses to an admin pin and an enforced org default; beats member pins, a soft org default and the fallback.`,
        additionalProperties: connectionIdSetJsonSchema,
      },
      dependency_overrides: {
        type: ["object", "null"],
        description:
          'Per-run dependency version overrides (#666). Flat map: `{ "@scope/skill": "draft" | "<semver|dist-tag>" }`. A `"draft"` value means the run consumed a dependency\'s mutable working copy — so it is NOT reproducible from `version_ref` alone. Null when the run resolved the manifest pins verbatim against published versions.',
        additionalProperties: { type: "string" },
      },
      connections_used: {
        type: ["array", "null"],
        description:
          "Connections resolved for this run, projected from the internal snapshot for display — one entry per BOUND connection, so an integration bound to several contributes several entries sharing an `integration_package_id`. Null when the agent declares no integrations.",
        items: {
          type: "object",
          required: ["integration_package_id", "label", "account_id", "source"],
          properties: {
            integration_package_id: { type: "string" },
            label: { type: "string", description: "The connection's label, copied at kickoff." },
            account_id: {
              type: "string",
              description: "Its account identifier, copied at kickoff.",
            },
            source: {
              type: "string",
              enum: [...CONNECTION_RESOLUTION_SOURCES],
              description: "The cascade layer that bound the connection.",
            },
          },
        },
      },
      integrations_unbound: {
        type: ["array", "null"],
        description:
          "Declared integrations this run started without, and why — the launch `warnings` recorded at kickoff, without their candidate or auth detail. In declaration order; empty when every one was bound; null when the run recorded none (no connection resolution ran, or the run predates the record).",
        items: {
          type: "object",
          required: ["integration_package_id", "code", "source"],
          properties: {
            integration_package_id: { type: "string" },
            code: {
              type: "string",
              enum: [...CONNECTION_RESOLUTION_WARNING_CODES],
              description: "The launch warning's code (see ConnectionResolutionWarning).",
            },
            source: {
              type: ["string", "null"],
              enum: [...CONNECTION_RESOLUTION_SOURCES, null],
              description:
                "The cascade layer that chose no connection, on `integration_unbound`; null otherwise.",
            },
          },
        },
      },
    },
  },
  RunLog: {
    type: "object",
    required: ["id", "runId", "type", "level", "createdAt"],
    properties: {
      id: { type: "integer", format: "int64" },
      runId: { type: "string" },
      orgId: { type: "string" },
      type: { type: "string" },
      level: {
        type: "string",
        enum: ["debug", "info", "warn", "error"],
        description: "Log severity level. Non-admin users only receive info, warn, and error logs.",
      },
      // `event` / `message` / `data` are nullable columns on `run_logs`
      // (no NOT NULL) — a breadcrumb may carry only a message, only structured
      // data, or only an event kind. Mirror that on the wire.
      event: { type: ["string", "null"] },
      message: { type: ["string", "null"] },
      data: { type: ["object", "null"] },
      createdAt: { type: "string", format: "date-time" },
    },
  },
  Schedule: {
    type: "object",
    // Every schedule response routes through `toSchedule` + `enrichSchedules`
    // (services/scheduler.ts) — list, detail, create, and update all return the
    // actor-enriched shape — so the full field set is guaranteed. Exhaustive
    // `required` lets the SPA drop its `as EnrichedSchedule` casts and lets
    // verify-openapi step 7 guard it against `EnrichedSchedule` drift.
    required: [
      "id",
      "packageId",
      "userId",
      "endUserId",
      "orgId",
      "spaceId",
      "name",
      "enabled",
      "disabled_reason",
      "cron_expression",
      "timezone",
      "input",
      "generation_config_override",
      "model_id_override",
      "proxy_id_override",
      "version_override",
      "connection_overrides",
      "dependency_overrides",
      "last_run_at",
      "next_run_at",
      "createdAt",
      "updatedAt",
      "actor_name",
      "actor_type",
      "running_runs",
      "unread_count",
      "last_run_number",
    ],
    properties: {
      id: { type: "string" },
      packageId: { type: "string" },
      userId: { type: ["string", "null"], description: "Member actor the schedule runs as" },
      endUserId: { type: ["string", "null"], description: "End-user actor the schedule runs as" },
      orgId: { type: "string" },
      spaceId: {
        type: "string",
        pattern: SPACE_ID_RE.source,
        description: "Space ID (spc_ prefix) that owns this schedule",
      },
      name: { type: ["string", "null"] },
      enabled: { type: "boolean" },
      disabled_reason: {
        type: ["string", "null"],
        enum: [...scheduleDisabledReasonValues, null],
        description:
          "The system act that disabled the schedule; `null` while `enabled` is true and when a write switched it off (`PATCH` with `enabled: false`). `actor_invalid`: a fire found its actor can no longer run agents in this space. `actor_left_org`: its member actor left or was removed from the organization. `connection_deleted`: a connection its `connection_overrides` named was deleted. On the schedule of the connection's owner, that emptied the integration's set, whose key is dropped — re-enabling resolves that integration through the rest of the cascade, so re-check `connection_overrides` first. On another actor's schedule the overrides keep the id: while the connection stays unreachable, re-enabling requires a new choice. `connection_unshared`: a connection another actor owns, which its `connection_overrides` named, stopped being shared; the overrides keep the id: while the connection stays unreachable, re-enabling requires a new choice. Cleared by re-enabling.",
      },
      cron_expression: { type: "string" },
      timezone: { type: "string" },
      input: { type: ["object", "null"], additionalProperties: true },
      generation_config_override: {
        oneOf: [{ $ref: "#/components/schemas/ModelGenerationSettings" }, { type: "null" }],
      },
      model_id_override: { type: ["string", "null"] },
      proxy_id_override: { type: ["string", "null"] },
      version_override: { type: ["string", "null"] },
      connection_overrides: {
        type: ["object", "null"],
        description: `Per-integration connection picks frozen on the schedule row (cascade layer 3, the launch override of every fire). Map of sets: \`{ "@scope/integration": ["<connection_id>", ...] }\`, 0..${MAX_CONNECTIONS_PER_INTEGRATION} per integration (\`[]\` = none, see the set schema). Replayed on every fire; loses to an admin pin and an enforced org default, beats member pins, a soft org default and the fallback.`,
        additionalProperties: connectionIdSetJsonSchema,
      },
      dependency_overrides: {
        type: ["object", "null"],
        description:
          'Per-dependency version overrides frozen on the schedule row (#666/#686). Flat map: `{ "@scope/dep": "draft" | "<semver|dist-tag>" }`; keys may name a declared skill OR integration. Forwarded to each fired run\'s `dependency_overrides` so a scheduled run resolves its dependencies exactly as the schedule froze them.',
        additionalProperties: { type: "string" },
      },
      last_run_at: { type: ["string", "null"], format: "date-time" },
      next_run_at: { type: ["string", "null"], format: "date-time" },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
      actor_name: { type: ["string", "null"], description: "Display name of the schedule actor" },
      actor_type: { type: ["string", "null"], enum: ["user", "end_user", null] },
      running_runs: {
        type: "integer",
        minimum: 0,
        description: "Runs of this schedule currently pending or running.",
      },
      unread_count: {
        type: "integer",
        minimum: 0,
        description:
          "Runs of this schedule whose notification is unread by the CALLER. Scoped to the requesting actor, like `EnrichedRun.unread`.",
      },
      last_run_number: {
        type: "integer",
        minimum: 0,
        description: "Highest run number this schedule ever produced; 0 when it never fired.",
      },
    },
  },
  ApiKeyInfo: {
    type: "object",
    // created_by/expiresAt/lastUsedAt/revokedAt are always emitted by
    // listApiKeys (nullable columns, always selected). created_by_name stays
    // optional (omitted when the creator is unknown).
    required: [
      "id",
      "name",
      "keyPrefix",
      "scopes",
      "created_by",
      "expiresAt",
      "lastUsedAt",
      "revokedAt",
      "createdAt",
    ],
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      keyPrefix: {
        type: "string",
        description: "The first characters of the key, for identification: `apst_` + 8.",
      },
      scopes: {
        type: "array",
        items: { type: "string" },
        description: "Permission scopes granted to this API key.",
      },
      created_by: { type: ["string", "null"] },
      created_by_name: { type: "string" },
      expiresAt: { type: ["string", "null"], format: "date-time" },
      lastUsedAt: { type: ["string", "null"], format: "date-time" },
      revokedAt: { type: ["string", "null"], format: "date-time" },
      createdAt: { type: "string", format: "date-time" },
    },
  },
  OrgPackageItem: {
    type: "object",
    // Always emitted by the listOrgItems mapper. `created_by_name` stays
    // optional (omitted when there's no creator); `scope` is not emitted by
    // the org-package list (shared-type marks it optional).
    required: [
      "id",
      "source",
      "createdAt",
      "updatedAt",
      "name",
      "description",
      "icon",
      "keywords",
      "created_by",
      "used_by_agents",
      "version",
      "auto_installed",
      "forked_from",
      "home_space_id",
      "home_writable",
      "home_deletable",
      "home_shareable",
    ],
    properties: {
      id: { type: "string" },
      orgId: {
        type: ["string", "null"],
        description: "Owning organization ID (null for system packages)",
      },
      name: { type: "string" }, // getPackageDisplayName always returns a string (falls back to id)
      description: { type: ["string", "null"] },
      icon: {
        type: ["string", "null"],
        description:
          "The manifest's `icon` (an Iconify id), `null` when it declares none. Read off the same rendered manifest as `name` and `description`, so an index page can draw its cards from this listing alone.",
      },
      keywords: {
        type: "array",
        items: { type: "string" },
        description:
          "The manifest's `keywords`, `[]` when it declares none — what an index page's search matches on beyond the name and the description.",
      },
      source: { type: "string", enum: [...packageSourceValues] },
      created_by: { type: ["string", "null"] },
      created_by_name: { type: "string" },
      used_by_agents: { type: "integer" },
      version: { type: ["string", "null"], description: "Manifest version (semver)" },
      auto_installed: { type: "boolean" },
      forked_from: { type: ["string", "null"], description: "Source package ID if forked" },
      ...PACKAGE_HOME_PROPERTIES,
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
  },
  OrgPackageItemDetail: {
    type: "object",
    // Always emitted by buildPackageDetailDto. `content` is present but the
    // draft_content column is nullable, so it is required-but-nullable. The
    // detail endpoint does not emit `used_by_agents`/`created_by_name`/`scope`
    // (the shared-type marks those optional on the detail shape).
    required: [
      "id",
      "source",
      "createdAt",
      "updatedAt",
      "name",
      "description",
      "content",
      "created_by",
      "version",
      "auto_installed",
      "forked_from",
      "home_space_id",
      "home_writable",
      "home_deletable",
      "home_shareable",
      "agents",
      "definition",
    ],
    properties: {
      id: { type: "string" },
      orgId: {
        type: ["string", "null"],
        description: "Owning organization ID (null for system packages)",
      },
      name: { type: "string" }, // getPackageDisplayName always returns a string (falls back to id)
      description: { type: ["string", "null"] },
      definition: {
        type: "string",
        enum: ["draft", "published"],
        description:
          'WHICH definition `content`, `manifest` and every field projected from them were read from: `draft` is the author\'s working copy, `published` a `package_versions` snapshot (the `latest` one, or the version `?version=` named). With no selector: the draft for a caller who may WRITE the package, otherwise the latest published version, and — when nothing is published — the draft in read-only, because a package the listing shows must have a page. The SAME rule and the same two functions the agent detail and the file explorer use, so the Content tab and the Files tab can never disagree about which bytes they are showing. `definition: "draft"` together with `home_writable: false` means "never published, you are seeing the author\'s work in progress".',
      },
      content: {
        type: ["string", "null"],
        description:
          "The package's primary content: `SKILL.md` for a skill, `INTEGRATION.md` for an integration, the manifest text for an mcp-server (which has no companion file of its own) and for an integration published without one. Read from the draft or from the published archive according to `definition`.",
      },
      source: { type: "string", enum: [...packageSourceValues] },
      created_by: { type: ["string", "null"] },
      auto_installed: { type: "boolean" },
      version: { type: ["string", "null"], description: "Manifest version (semver)" },
      manifest: { type: "object", description: "Full manifest object" },
      manifest_name: {
        type: ["string", "null"],
        description: "Manifest name (@scope/name) — may differ from package ID",
      },
      version_count: {
        type: "integer",
        description: "Number of published versions",
      },
      has_unarchived_changes: {
        type: "boolean",
        description: "Whether the active version has changes not yet archived as a version",
      },
      forked_from: { type: ["string", "null"], description: "Source package ID if forked" },
      ...PACKAGE_HOME_PROPERTIES,
      agents: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "display_name"],
          properties: {
            id: { type: "string" },
            display_name: { type: "string" },
          },
        },
      },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
  },
  ModelProviderCredential: {
    type: "object",
    required: [
      "id",
      "label",
      "apiShape",
      "base_url",
      "source",
      "authMode",
      "owner_type",
      "owner_id",
      "owner_name",
      "created_by",
      "createdAt",
      "updatedAt",
    ],
    properties: {
      id: { type: "string" },
      label: { type: "string" },
      apiShape: {
        type: ["string", "null"],
        description:
          "Protocol family. `null` for a built-in credential whose every model is managed (#727) — the binding is not exposed, so the endpoint doesn't reveal the provider.",
      },
      base_url: {
        type: ["string", "null"],
        description:
          "Endpoint base URL. `null` for a managed-only built-in credential (see apiShape).",
      },
      source: { type: "string", enum: ["built-in", "custom"] },
      authMode: { type: "string", enum: ["api_key", "oauth2"] },
      providerId: {
        type: ["string", "null"],
        description:
          "Canonical providerId backing the credential. Always set for a `custom` credential (the model form matches a custom endpoint's saved keys on it); `null` for a `built-in` one, whose backing is hidden.",
      },
      oauth_email: { type: ["string", "null"] },
      needs_reconnection: { type: "boolean" },
      owner_type: {
        type: "string",
        enum: ["org", "user"],
        description:
          "`user` for a personal credential, usable and editable by `owner_id` only; `org` for an organization or built-in credential.",
      },
      owner_id: {
        type: ["string", "null"],
        description: "The owning member's user id for a personal credential; `null` for `org`.",
      },
      owner_name: {
        type: ["string", "null"],
        description: "Display name of `owner_id`; `null` for `org`.",
      },
      created_by: { type: ["string", "null"] },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
  },
  OrgModel: {
    type: "object",
    required: [
      "id",
      "label",
      "apiShape",
      "providerId",
      "provider_name",
      "pi_provider",
      "pi_dialect",
      "base_url",
      "modelId",
      "generation",
      "enabled",
      "is_default",
      "needs_reconnection",
      "aliased",
      "iconUrl",
      "source",
      "credentialId",
      "billed_to",
      "created_by",
      "createdAt",
      "updatedAt",
    ],
    properties: {
      id: { type: "string" },
      label: { type: "string" },
      apiShape: {
        type: ["string", "null"],
        description:
          "Protocol family. `null` for managed models (`aliased: true`) — binding not exposed.",
      },
      providerId: {
        type: ["string", "null"],
        description:
          "The credential's provider id (e.g. `anthropic`, `claude-code`, `codex`). Distinguishes subscription providers that share an `apiShape` with an API-key provider so clients route them to the right proxy path. Also set on an unbound model (`credentialId: null`), where it names the provider each member's own credential must come from. `null` for managed models — binding not exposed.",
      },
      provider_name: {
        type: ["string", "null"],
        description:
          "The provider's human display name resolved from the model-provider registry by `providerId` (e.g. `OpenCode Go`, `OpenAI`). The authoritative label for grouping/badging a model by provider — `apiShape` is ambiguous (OpenCode Go and OpenAI both use `openai-completions`), so do NOT derive a provider label from it. `null` for managed models (binding not exposed) and for rows whose `providerId` has no registry entry.",
      },
      pi_provider: {
        type: ["string", "null"],
        description:
          "Key of the Pi model-registry provider this model is served through (e.g. `moonshotai` for `moonshot`): the provider a client builds its Pi model under. `null` for a gateway (`openai-compatible`, `anthropic-compatible`), which has no registry record, and for managed models — binding not exposed.",
      },
      pi_dialect: {
        type: ["object", "null"],
        description:
          "What the Pi model registry records about this model's request dialect, for a client that builds its own Pi model. Opaque: Pi's own vocabulary, handed to the Pi SDK as is. `null` for a model the registry does not record and for managed models — binding not exposed.",
        additionalProperties: true,
      },
      base_url: {
        type: ["string", "null"],
        description: "Provider endpoint. `null` for managed models — binding not exposed.",
      },
      modelId: {
        type: ["string", "null"],
        description: "Upstream model id. `null` for managed models — not exposed.",
      },
      generation: {
        oneOf: [{ $ref: "#/components/schemas/ModelGenerationCapabilities" }, { type: "null" }],
        description:
          "Generation controls supported by the backing model. Null for managed aliases whose binding is hidden.",
      },
      input: {
        type: ["array", "null"],
        items: { type: "string", enum: [...MODEL_INPUT_MODALITIES] },
      },
      contextWindow: { type: ["integer", "null"] },
      maxTokens: { type: ["integer", "null"] },
      reasoning: { type: ["boolean", "null"] },
      enabled: { type: "boolean" },
      is_default: { type: "boolean" },
      needs_reconnection: {
        type: "boolean",
        description:
          "True when the model's stored credential can no longer be used for inference — an OAuth credential flagged as needing reconnection, or (either auth mode) a stored secret that no longer decrypts. The model is listed so it can be inspected, detached or deleted, but it is not usable for inference and cannot be made the organization default. Always false for built-in models, which read their key from the environment. On an unbound model (`credentialId: null`) it is read for the caller, like `billed_to`: true when nothing of the caller's serves it and one of their own credentials for it must be reconnected.",
      },
      aliased: {
        type: "boolean",
        description:
          "Managed-model flag. When true, the binding (`modelId`, `apiShape`, `base_url`, `credentialId`, capabilities/cost) is not exposed in this projection — these fields are `null`; render a managed badge.",
      },
      iconUrl: {
        type: ["string", "null"],
        description:
          "Display-icon key for the UI (a client provider-icon key, e.g. `anthropic`, `openai`). A deliberate public choice on the model — decoupled from the provider, so a managed model can show an icon without exposing its binding. `null` means resolve the icon from the (visible) `apiShape`/`base_url`, or fall back to a generic icon.",
      },
      source: { type: "string", enum: ["built-in", "custom"] },
      credentialId: {
        type: ["string", "null"],
        description:
          "ID of the organization `model_provider_credentials` row the model is bound to. `null` when the model is unbound: each member serves it with their own personal credential for `providerId` (`billed_to` says whether the caller has one). `null` for managed models — binding not exposed.",
      },
      billed_to: {
        type: ["string", "null"],
        enum: ["user", "org", null],
        description:
          "Who pays for a call to this model, for the caller. `org` — a built-in model or a model bound to an organization credential: the organization (or the platform) pays whoever calls (a dead credential is `needs_reconnection`). `user` — an unbound model (`credentialId: null`) one of the caller's own personal credentials serves. `null` — an unbound model nothing of the caller's serves: a spend is refused (`409 model_credential_required`). Read for runs and chat: the public LLM proxy (`/api/llm-proxy`, used by remote runs) never serves a subscription, so a caller whose only applicable credential is a subscription has none there.",
      },
      cost: {
        type: ["object", "null"],
        description: "Cost in USD per million tokens",
        properties: {
          input: { type: "number" },
          output: { type: "number" },
          cacheRead: { type: "number" },
          cacheWrite: { type: "number" },
          tiers: {
            type: "array",
            maxItems: MAX_TOKEN_USAGE_TIERS,
            items: { $ref: "#/components/schemas/ModelCostTier" },
          },
        },
      },
      created_by: { type: ["string", "null"] },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
  },
  TestResult: {
    type: "object",
    required: ["ok", "latency"],
    properties: {
      ok: { type: "boolean" },
      latency: { type: "number", description: "Response time in milliseconds" },
      error: { type: "string", description: "Error code if test failed" },
      message: { type: "string", description: "Human-readable error message" },
      status: {
        type: "integer",
        description:
          "Upstream HTTP status when the provider answered at all — distinguishes 429 (retry later) from 404 (model not served).",
      },
    },
  },
  OAuthTokenResponse: {
    type: "object",
    description:
      "Resolved access token returned by `GET /internal/oauth-token/{id}` and `POST .../refresh`. Carries only the fields that change per refresh — provider invariants (baseUrl, …) live in the sidecar's boot-time `LlmProxyOauthConfig`. Wire-equivalent to the `OAuthTokenResponse` TS interface in `@appstrate/core/sidecar-types`.",
    required: ["access_token", "expiresAt"],
    properties: {
      access_token: { type: "string" },
      expiresAt: {
        type: ["integer", "null"],
        description: "Epoch milliseconds. null when expiry is unknown.",
      },
      account_id: {
        type: "string",
        description:
          "Abstract account/tenant identifier surfaced by the provider's `extractTokenIdentity` hook. Omitted when the provider surfaced none. The sidecar's identity layer (keyed by providerId from the boot config) decides which routing header to echo it as.",
      },
    },
  },
  IntegrationCredentialsResponse: {
    type: "object",
    description:
      "Live credentials + per-auth HTTP delivery plans + per-auth expiries for an active integration. Returned by both `GET /internal/integration-credentials/{scope}/{name}` and `POST .../refresh` (identical shape). Feeds the sidecar's MITM `MitmCredentialSource.current()` + `.deliveryPlans()`. All wire keys are snake_case per AFPS (see `docs/CASING_CONVENTIONS.md` — internal sidecar↔platform endpoints share the Zone 1 default).",
    required: ["auths", "delivery_plans", "expires_at_epoch_ms"],
    properties: {
      auths: {
        type: "array",
        items: {
          type: "object",
          required: ["auth_key", "auth_type", "fields", "authorized_uris"],
          properties: {
            auth_key: { type: "string" },
            auth_type: { type: "string" },
            fields: { type: "object", additionalProperties: { type: "string" } },
            authorized_uris: { type: "array", items: { type: "string" } },
            resource: {
              type: "string",
              description:
                "RFC 8707 resource indicator declared by the manifest (`auths.{key}.resource`). AFPS §7.3 name — matches the RFC.",
            },
            expires_at: { type: "string", format: "date-time" },
            scopes_granted: { type: "array", items: { type: "string" } },
          },
        },
      },
      delivery_plans: {
        type: "object",
        additionalProperties: {
          type: "object",
          required: ["header_name", "header_prefix", "value", "allow_server_override"],
          properties: {
            header_name: { type: "string" },
            header_prefix: { type: "string" },
            value: { type: "string" },
            allow_server_override: { type: "boolean" },
          },
        },
      },
      expires_at_epoch_ms: {
        type: "object",
        additionalProperties: { type: ["integer", "null"] },
      },
      rejection_streak: {
        type: "integer",
        minimum: 1,
        description:
          "Consecutive upstream rejections counted against this non-OAuth2 connection; omitted when none. The sidecar reports its next successful call to `POST .../upstream-success`, which ends the streak.",
      },
      credential_revision: {
        type: "string",
        description:
          "Opaque revision of the stored credential this payload carries (a short digest of its ciphertext; every credential write changes it). The sidecar sends it back as `credential_revision` on `/refresh` and `/upstream-success`, so a rejection or a success is applied to this credential only. Omitted on a connect run's empty payload.",
      },
    },
  },
  IntegrationAgentResolution: {
    type: "object",
    description:
      "Per-integration connection verdict for an agent: which connections the next run binds (admin pin → enforced org default → launch override → member pin → soft org default → fallback, each layer a set and the fallback binding the caller's own connection; among several, the least-privileged covering one when they share one oauth2 account, auth and instance; otherwise `must_choose_connection`, never a shared one; then a health and scope check), the annotated candidate list, and admin/member pin + blocked state. Computed by the same resolver the runtime uses, and reported in its vocabulary: `source`, `error_code`, `warning`. Readiness carries no launch override, so `source` is never `run_override` / `schedule_override` here.",
    required: [
      "source",
      "error_code",
      "warning",
      "resolved_connection_ids",
      "resolved_missing_scopes",
      "admin_pinned_connection_ids",
      "member_pinned_connection_ids",
      "org_default_connection_ids",
      "org_default_enforced",
      "can_add_connection",
      "candidates",
    ],
    properties: {
      source: {
        type: ["string", "null"],
        enum: [...CONNECTION_RESOLUTION_SOURCES, null],
        description:
          "The cascade layer that bound a non-empty set, or the layer whose set failed (an unreachable member — `pinned_connection_unavailable` / `override_connection_unavailable`; a launch override outside the governing set — `override_outranked`; an empty set on a required integration — `required_integration_unbound`; or one failing its health check — `needs_reconnection`, `insufficient_scopes`, `auth_serves_no_selected_tool`). `null` when no layer bound anything (`not_connected`, `must_choose_connection`, `auth_key_mismatch`, `auth_key_serves_no_selected_tool`, `integration_not_active`), when the integration binds none (`[]` — `warning.source` names the layer that chose it) and when there is no verdict at all (the integration manifest could not be loaded; `error_code` is then `null` too).",
      },
      error_code: {
        type: ["string", "null"],
        enum: [...CONNECTION_RESOLUTION_ERROR_CODES, null],
        description:
          "Why a run would be refused on this integration — the same code the run-kickoff 409 carries. `null` when the set binds (`[]` included), for a non-required integration switched off in the space, and when there is no verdict.",
      },
      warning: {
        anyOf: [{ $ref: "#/components/schemas/ConnectionResolutionWarning" }, { type: "null" }],
        description:
          "Why the next run would start without this integration — its launch `warnings[]` item. `null` when the resolver emits no warning for it.",
      },
      resolved_connection_ids: {
        type: "array",
        items: { type: "string" },
        maxItems: MAX_CONNECTIONS_PER_INTEGRATION,
        description:
          "The set the next run binds — empty when it binds none. When a member fails its health check (`needs_reconnection`, `insufficient_scopes`, `auth_serves_no_selected_tool`), the whole set that layer tried to bind; empty on any other error.",
      },
      resolved_missing_scopes: {
        type: "array",
        items: { type: "string" },
        description:
          "Missing scopes on the one connection an `insufficient_scopes` verdict names; empty otherwise.",
      },
      admin_pinned_connection_ids: {
        type: ["array", "null"],
        items: { type: "string" },
        maxItems: MAX_CONNECTIONS_PER_INTEGRATION,
        description: "`null` when no admin pin exists; `[]` when it pins none.",
      },
      member_pinned_connection_ids: {
        type: ["array", "null"],
        items: { type: "string" },
        maxItems: MAX_CONNECTIONS_PER_INTEGRATION,
        description: "`null` when the caller has no member pin; `[]` when it pins none.",
      },
      org_default_connection_ids: {
        type: ["array", "null"],
        items: { type: "string" },
        minItems: 1,
        maxItems: MAX_CONNECTIONS_PER_INTEGRATION,
        description: "`null` when no org default exists; an org default is never empty.",
      },
      org_default_enforced: { type: "boolean" },
      can_add_connection: {
        type: "boolean",
        description:
          "Whether the caller may create a connection for this integration: holds `integrations:connect`, and either holds `integrations:configure` or the space does not block member connections.",
      },
      candidates: {
        type: "array",
        description:
          "Every connection accessible to the caller on an auth serving the agent's selected tools — the list a `must_choose_connection` 409 carries. An integration with no selection keeps every auth.",
        items: {
          type: "object",
          required: [
            "id",
            "auth_key",
            "account_id",
            "label",
            "owner_user_id",
            "owner_end_user_id",
            "owner_name",
            "scopes_granted",
            "scope",
            "space_id",
            "shared_here",
            "needs_reconnection",
            "missing_scopes",
            "is_own",
          ],
          properties: {
            id: { type: "string", format: "uuid" },
            auth_key: { type: "string" },
            account_id: { type: "string" },
            label: {
              type: "string",
              description:
                "User-given name. Always present — the column is NOT NULL, because a run binding several connections of one integration addresses each by its label.",
            },
            owner_user_id: { type: ["string", "null"] },
            owner_end_user_id: { type: ["string", "null"] },
            owner_name: { type: ["string", "null"] },
            scopes_granted: { type: "array", items: { type: "string" } },
            scope: connectionScopeSchema,
            space_id: spaceIdSchema,
            shared_here: sharedHereSchema,
            shared_space_ids: sharedSpaceIdsSchema,
            origin_space_id: originSpaceIdSchema,
            needs_reconnection: { type: "boolean" },
            missing_scopes: { type: "array", items: { type: "string" } },
            is_own: { type: "boolean" },
          },
        },
      },
    },
  },
  AgentConnectionReadiness: {
    type: "object",
    description:
      "What stands between this agent and a run, in one call: the connection verdict (mirroring the run-kickoff 409, run semantics) plus the space's own activation switch. `integrations[]` carries every declared integration's management verdict for the Connexions tab.",
    required: ["blocks_run", "errors", "integrations"],
    properties: {
      blocks_run: {
        type: "boolean",
        description:
          "True iff `POST /api/agents/{scope}/{name}/run` would refuse — a connection the resolver rejects (409), or the agent being switched off in this space (404 `agent_not_active_in_space`). Equivalently: `errors` is non-empty.",
      },
      errors: {
        type: "array",
        description:
          'What blocks the run. The integration portion of the 409 envelope (same `field: integrations.<id>` shape as ProblemDetail.errors), plus, FIRST when it applies, `{ field: "agent", code: "agent_not_active" }` — the space has switched the agent off, so the run doors answer `404 agent_not_active_in_space` while this read answers 200 and says why. The remedy is `POST /api/spaces/{spaceId}/packages`. Shares the single ResolutionFieldError component so the shape can\'t drift from the 409 error items.',
        items: {
          allOf: [
            { $ref: "#/components/schemas/ResolutionFieldError" },
            {
              type: "object",
              properties: {
                code: {
                  type: "string",
                  enum: [...CONNECTION_RESOLUTION_ERROR_CODES, "agent_not_active"],
                },
              },
            },
          ],
        },
      },
      integrations: {
        type: "array",
        items: {
          type: "object",
          required: ["integration_package_id", "required", "run_blocking", "resolution"],
          properties: {
            integration_package_id: { type: "string" },
            required: {
              type: "boolean",
              description:
                "The agent's `integrations_configuration.<id>.required`: whether a run refuses to start without a connection here.",
            },
            run_blocking: {
              type: "boolean",
              description:
                "True iff this integration is one of the run-blocking `errors` — not one the run starts without (`resolution.warning`).",
            },
            resolution: { $ref: "#/components/schemas/IntegrationAgentResolution" },
          },
        },
      },
    },
  },
  // A block to run on the target.
  HandoffCommandStep: {
    type: "object",
    required: ["kind", "id", "label", "shell"],
    properties: {
      kind: { type: "string", enum: ["command"] },
      id: {
        type: "string",
        description:
          "Stable identifier a client can key a translation on; `label`/`note` are the English default.",
      },
      label: { type: "string" },
      shell: {
        type: "string",
        description: "Shell to run on the target. The platform never runs it.",
      },
      note: { type: "string" },
      deferred: {
        type: "boolean",
        description:
          "Due when the connection is deleted, not now. Only on `submitIntegrationConnect`; `getMyConnectionHandoff` omits it.",
      },
    },
  },
  // A value to read or compare — a fingerprint, an identifier.
  HandoffValueStep: {
    type: "object",
    required: ["kind", "id", "label", "value"],
    properties: {
      kind: { type: "string", enum: ["value"] },
      id: {
        type: "string",
        description:
          "Stable identifier a client can key a translation on; `label`/`note` are the English default.",
      },
      label: { type: "string" },
      value: { type: "string" },
      note: { type: "string" },
    },
  },
  // One step a user runs or checks on their own machine for a minted credential.
  HandoffStep: {
    oneOf: [
      { $ref: "#/components/schemas/HandoffCommandStep" },
      { $ref: "#/components/schemas/HandoffValueStep" },
    ],
    discriminator: {
      propertyName: "kind",
      mapping: {
        command: "#/components/schemas/HandoffCommandStep",
        value: "#/components/schemas/HandoffValueStep",
      },
    },
  },

  IntegrationPin: {
    type: "object",
    required: [
      "agent_package_id",
      "integration_package_id",
      "connection_ids",
      "createdAt",
      "updatedAt",
    ],
    properties: {
      agent_package_id: { type: "string" },
      integration_package_id: { type: "string" },
      connection_ids: {
        ...connectionIdSetJsonSchema,
        description:
          "The whole pinned set, in the order it was written — `[]` pins none. A write replaces it.",
      },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
  },
  OrgProxy: {
    type: "object",
    required: [
      "id",
      "label",
      "urlPrefix",
      "enabled",
      "is_default",
      "source",
      "created_by",
      "createdAt",
      "updatedAt",
    ],
    properties: {
      id: { type: "string" },
      label: { type: "string" },
      urlPrefix: {
        type: "string",
        description: "Proxy URL for display, its username and password both masked",
      },
      enabled: { type: "boolean" },
      is_default: { type: "boolean" },
      source: { type: "string", enum: ["built-in", "custom"] },
      created_by: { type: ["string", "null"] },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
  },
  SpaceSweepResult: {
    type: "object",
    required: ["object", "spaceId", "rehomed_packages", "deleted_packages"],
    properties: {
      object: { type: "string", enum: ["space_sweep"] },
      spaceId: { type: "string", description: "The personal space that was swept and deleted" },
      rehomed_packages: {
        type: "integer",
        description:
          "Packages this space homed that another space has placed: re-homed to the organization's default space rather than deleted",
      },
      deleted_packages: {
        type: "integer",
        description: "Packages this space homed that no other space had placed: deleted",
      },
    },
  },
  SpaceObject: {
    type: "object",
    required: [
      "id",
      "object",
      "orgId",
      "name",
      "isDefault",
      "settings",
      "visibility",
      "default_role",
      "personal",
      "access",
      "role",
      "permissions",
      "created_by",
      "createdAt",
      "updatedAt",
    ],
    properties: {
      id: { type: "string", pattern: SPACE_ID_RE.source, description: "Space ID (spc_ prefix)" },
      object: { type: "string", enum: ["space"], description: "Object type" },
      orgId: { type: "string", description: "Organization ID" },
      name: { type: "string", description: "Human-readable space name" },
      isDefault: { type: "boolean", description: "Whether this is the default space" },
      settings: {
        type: "object",
        properties: {
          allowedRedirectDomains: {
            type: "array",
            items: { type: "string" },
            description: "Domains allowed for OAuth redirect callbacks",
          },
        },
      },
      visibility: {
        type: "string",
        enum: [...SPACE_VISIBILITIES],
        description:
          "Who reaches the space without an explicit membership row: `open` (every org member), `closed` (listed, not enterable), `private` (not listed).",
      },
      default_role: {
        type: "string",
        enum: [...SPACE_ROLE_PRESETS],
        description: "Preset the implicit members of an `open` space hold",
      },
      personal: {
        type: "boolean",
        description:
          "Whether this space is one member's personal space. Such a space is reached by its owner alone — organization owners and admins included — takes no other members, is always `private`, and only its name can be changed. Its owner is deliberately not named on the wire.",
      },
      orphaned_at: {
        type: ["string", "null"],
        format: "date-time",
        description:
          "When the owner of this personal space stopped being a member of the organization; null while they are one. Present only for organization owners and admins, the only callers an orphaned personal space is listed to — they may convert it to a team space or sweep it immediately. Absent on every other projection.",
      },
      access: {
        type: "string",
        enum: ["member", "none"],
        description: "Whether the caller may enter this space",
      },
      role: {
        type: ["object", "null"],
        required: ["kind", "key", "name"],
        properties: {
          kind: { type: "string", enum: ["preset", "custom"] },
          key: { type: "string" },
          name: { type: "string" },
        },
        description: "The caller's role in this space, or null when they have none",
      },
      permissions: {
        type: "array",
        items: { type: "string" },
        description: "The caller's effective permission set in this space, ceiling applied",
      },
      created_by: {
        type: ["string", "null"],
        description: "ID of the user who created the space",
      },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
  },

  SpaceMemberObject: {
    type: "object",
    required: ["object", "userId", "name", "email", "org_role", "source", "role", "createdAt"],
    properties: {
      object: { type: "string", enum: ["space_member"] },
      userId: { type: "string" },
      name: { type: ["string", "null"] },
      email: { type: ["string", "null"] },
      org_role: { type: "string", enum: ORG_ROLES },
      source: {
        type: "string",
        enum: ["explicit", "org_role", "open_space"],
        description:
          "How the principal reaches the space: an explicit row, their org role (owner/admin), or the open space's default.",
      },
      role: {
        type: ["object", "null"],
        required: ["kind", "key", "name"],
        properties: {
          kind: { type: "string", enum: ["preset", "custom"] },
          key: { type: "string" },
          name: { type: "string" },
        },
      },
      createdAt: {
        type: ["string", "null"],
        format: "date-time",
        description: "When the explicit row was written; null for an implicit member",
      },
    },
  },

  SpaceMemberAssignment: {
    type: "object",
    required: ["object", "userId"],
    properties: {
      object: { type: "string", enum: ["space_member"] },
      userId: { type: "string" },
      preset_role: { type: "string", enum: [...SPACE_ROLE_PRESETS] },
      custom_role_id: { type: "string", pattern: SPACE_ROLE_ID_PATTERN },
    },
  },

  RoleObject: {
    type: "object",
    required: [
      "object",
      "kind",
      "id",
      "key",
      "name",
      "description",
      "permissions",
      "unavailable_permissions",
      "createdAt",
      "updatedAt",
    ],
    description:
      "A space role: one of the four platform presets (read-only, `id: null`) or an organization-defined bundle.",
    properties: {
      object: { type: "string", enum: ["role"] },
      kind: { type: "string", enum: ["preset", "custom"] },
      id: {
        type: ["string", "null"],
        description: "`srl_` id for a custom bundle; null for a preset, which has no row.",
      },
      key: { type: "string" },
      name: { type: "string" },
      description: { type: ["string", "null"] },
      permissions: {
        type: "array",
        items: { type: "string" },
        description:
          "Space-level permission strings the role grants on this deployment, sorted. " +
          "A custom bundle is projected through the same vocabulary enforcement uses, so " +
          "this array is always one a `PATCH` accepts back.",
      },
      unavailable_permissions: {
        type: "array",
        items: { type: "string" },
        description:
          "Entries stored on the bundle that this deployment cannot name — their module is " +
          "no longer loaded — sorted. They grant nothing and are never part of `permissions`; " +
          "sending a `permissions` array without them is what drops them from the row. " +
          "Always empty for a preset.",
      },
      createdAt: { type: ["string", "null"], format: "date-time" },
      updatedAt: { type: ["string", "null"], format: "date-time" },
    },
  },

  RoleVocabularyGroup: {
    type: "object",
    required: ["resource", "permissions"],
    description: "Space-level permissions of one resource, with their delegation facts.",
    properties: {
      resource: { type: "string" },
      permissions: {
        type: "array",
        items: {
          type: "object",
          required: ["permission", "action", "api_key_grantable", "requires_one_of"],
          properties: {
            permission: { type: "string" },
            action: { type: "string" },
            api_key_grantable: {
              type: "boolean",
              description: "Can also be carried by an API key.",
            },
            requires_one_of: {
              type: "array",
              items: { type: "string" },
              description:
                "The reads a role holding this permission must also hold, any one of them sufficing; " +
                "the first is the canonical one to add. Usually the resource's own `read`, not always " +
                "(`agents:run` needs a runs read). Empty when the permission needs none. " +
                "The authority on the rule: a create or update breaking it is a 400.",
            },
          },
        },
      },
    },
  },

  SpaceMemberRemoval: {
    type: "object",
    required: ["access_after"],
    properties: {
      access_after: {
        type: "string",
        enum: ["implicit", "none"],
        description:
          "Whether the removed member keeps implicit access (open space) or loses the space entirely.",
      },
    },
  },
  EndUserObject: {
    type: "object",
    // Every field is always serialized (toEndUserResponse in services/end-users.ts);
    // nullable fields are required-but-null on the wire, not omitted.
    required: [
      "id",
      "object",
      "spaceId",
      "name",
      "email",
      "externalId",
      "metadata",
      "createdAt",
      "updatedAt",
    ],
    properties: {
      id: { type: "string", description: "End-user ID (eu_ prefix)" },
      object: { type: "string", enum: ["end_user"], description: "Object type" },
      spaceId: { type: "string", description: "ID of the parent space" },
      name: { type: ["string", "null"], description: "Display name" },
      email: { type: ["string", "null"], format: "email", description: "Email address" },
      externalId: { type: ["string", "null"], description: "External system identifier" },
      metadata: {
        type: ["object", "null"],
        additionalProperties: true,
        description: "Arbitrary key-value metadata",
      },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
  },
  AgentManifest: {
    description:
      "AFPS Agent manifest extended with Appstrate platform fields. " +
      "Standard fields are defined by the AFPS Agent schema. Most extension fields use the x- prefix per AFPS §10, " +
      "with the exception of the Appstrate-specific top-level `runtime_tools` field documented below.",
    allOf: [
      { $ref: "https://schemas.afps.dev/v0/agent.schema.json" },
      {
        type: "object",
        properties: {
          runtime_tools: {
            type: "array",
            items: {
              type: "string",
              enum: RUNTIME_TOOL_IDS,
            },
            description:
              "Appstrate top-level extension: runtime tools the agent may use. Optional. " +
              "An id outside this enum is rejected on author input and dropped (with the " +
              "drop reported) when read back from a stored manifest.",
          },
        },
      },
    ],
  },
  FileConstraintsMap: {
    type: "object",
    description:
      "Upload constraints for file fields, keyed by property name. " +
      "Lives at the AFPS wrapper level (outside the JSON Schema).",
    additionalProperties: {
      type: "object",
      properties: {
        accept: {
          type: "string",
          description: "Comma-separated accepted file extensions (e.g. .pdf,.docx)",
        },
        max_size: {
          type: "number",
          description: "Maximum file size in bytes",
        },
      },
    },
  },
  UIHintsMap: {
    type: "object",
    description:
      "UI rendering hints for schema fields, keyed by property name. " +
      "Lives at the AFPS wrapper level (outside the JSON Schema).",
    additionalProperties: {
      type: "object",
      properties: {
        placeholder: {
          type: "string",
          description: "Hint text shown before the user provides a value",
        },
      },
    },
  },
  LibraryPackageList: {
    type: "array",
    description:
      "Packages of a single type visible to the org. Each entry carries its " +
      "`placements`: one entry per space the package is placed in and the caller reads, saying WHY it " +
      "is there (`via`) and whether that space runs it (`state`).",
    items: {
      type: "object",
      required: [
        "id",
        "type",
        "source",
        "name",
        "description",
        "home_space_id",
        "home_writable",
        "home_deletable",
        "home_shareable",
        "published",
        "placements",
      ],
      properties: {
        id: { type: "string", description: "Package id (`@scope/name`)." },
        type: { type: "string", enum: [...packageTypeValues] },
        source: {
          type: "string",
          description:
            "Package origin (`local` for org-owned packages, `system` for built-in system packages).",
        },
        name: {
          type: "string",
          description:
            "Display name from the package draft manifest (`manifest.display_name`); falls back to the package id.",
        },
        description: {
          type: "string",
          description:
            "Description from the package draft manifest; empty string when not provided.",
        },
        ...PACKAGE_HOME_PROPERTIES,
        published: {
          type: "boolean",
          description:
            "Whether the package has a published version (a `latest` dist-tag), or is a system package. A skill can be enforced in a space's chat only when it is published.",
        },
        placements: {
          type: "array",
          description:
            "Where this package is PLACED, restricted to spaces the caller reads this type in. Empty when the " +
            "package is placed nowhere the caller can see — which the space form still lists when the caller " +
            "could place it there in one click (a package whose home grants them `<type>:share`).",
          items: { $ref: "#/components/schemas/PackagePlacement" },
        },
      },
    },
  },
  PackagePlacement: {
    type: "object",
    description:
      "One (package, space) cell of the library map: why the package reaches that space, and whether the space runs it.",
    required: ["space_id", "via", "state", "chat_enforced", "shared_by"],
    properties: {
      space_id: {
        type: "string",
        description: "Space id (`spc_…`) — always one the caller reads.",
      },
      via: {
        type: "string",
        enum: ["home", "shared", "system"],
        description:
          "WHY the package is placed here: `home` (this space owns it and governs its draft), `shared` (it was offered to this space), `system` (a built-in package, readable in every space).",
      },
      state: {
        type: "string",
        enum: ["active", "inactive", "none"],
        description:
          "Whether the space RUNS it. `active`: yes. `inactive`: it was switched off here, and its per-space model, proxy and input settings are kept. `none`: nothing has switched it on yet — a pending offer is exactly this. Activate with `POST /api/spaces/{spaceId}/packages`, deactivate with `DELETE /api/spaces/{spaceId}/packages/{scope}/{name}`. The placement ROW always wins, for every package type: a system one switched off here reads `inactive`. With NO row the deployment's default decides — `source: 'system'`, and for an integration membership of this deployment's offered set (`SYSTEM_INTEGRATIONS`), so a system integration the deployment does not offer reads `none`.",
      },
      chat_enforced: {
        type: "boolean",
        description:
          "Whether this space enforces the skill in its chat (`SpacePackage.chat_enforced`). `false` with no placement row, and for every type but `skill`.",
      },
      shared_by: {
        type: ["object", "null"],
        description:
          'Who offered it — on `via: "shared"` placements only. `null` there when the offer came from a home move rather than from a person, once that account is gone, or once they have left this organization. Always `null` for `home` and `system`.',
        required: ["user_id", "name"],
        properties: {
          user_id: { type: "string" },
          name: { type: "string" },
        },
      },
    },
  },
  ShareTarget: {
    type: "object",
    description:
      "Who a package is offered to. A PERSON is not a space: a `user` target is resolved server-side to that member's personal space, so the sharer never handles the id of a space they cannot see. A `space` target must be one the caller can already reach — which is also why another member's personal space is not targetable by id.",
    required: ["kind"],
    oneOf: [
      {
        type: "object",
        required: ["kind", "userId"],
        properties: {
          kind: { type: "string", enum: ["user"] },
          userId: { type: "string", description: "Organization member's user id." },
        },
        additionalProperties: false,
      },
      {
        type: "object",
        required: ["kind", "spaceId"],
        properties: {
          kind: { type: "string", enum: ["space"] },
          spaceId: { type: "string", description: "Space id (`spc_…`) the caller can reach." },
        },
        additionalProperties: false,
      },
    ],
  },
  ShareTargetView: {
    type: "object",
    description:
      "A share's subject as the server renders it back. A personal-space target comes back as its OWNER — never as a space id, which is the one fact a personal space withholds.",
    required: ["kind", "name"],
    properties: {
      kind: { type: "string", enum: ["user", "space"] },
      userId: { type: "string", description: "Present when `kind` is `user`." },
      spaceId: { type: "string", description: "Present when `kind` is `space`." },
      name: {
        type: "string",
        description: "The member's display name, or the space's name.",
      },
    },
  },
  PackageShare: {
    type: "object",
    description:
      "One entry of a package's AUDIENCE (`package_shares`): a space the package is offered to. A share grants READ and the affordance to activate; it is never an activation, and no execution path consults it.",
    required: ["object", "target", "shared_by", "createdAt"],
    properties: {
      object: { type: "string", enum: ["package_share"] },
      target: { $ref: "#/components/schemas/ShareTargetView" },
      shared_by: {
        type: ["object", "null"],
        description:
          "Who shared it. `null` once that account is gone, and `null` once they have left this organization.",
        required: ["user_id", "name"],
        properties: {
          user_id: { type: "string" },
          name: { type: "string" },
        },
      },
      createdAt: { type: "string", format: "date-time" },
    },
  },
  PackageHome: {
    type: "object",
    description:
      "Where a package lives and where this caller reads it from, resolved across EVERY space the caller reaches rather than the one in `X-Space-Id` — the answer a client holding only a package id needs to know which space to address.",
    required: [
      "id",
      "type",
      "home_space_id",
      "home_writable",
      "home_deletable",
      "home_shareable",
      "read_space_ids",
    ],
    properties: {
      id: { type: "string", description: "Package id (`@scope/name`)." },
      type: { type: "string", enum: [...packageTypeValues] },
      ...PACKAGE_HOME_PROPERTIES,
      read_space_ids: {
        type: "array",
        items: { type: "string" },
        description:
          "Spaces (`spc_…`) where this caller holds the package type's read AND the placement grants it — the home, or a space it is offered to; every reachable space holding that read for a system package. The home comes first when it is one of them, the rest sorted by id. Never empty: a package readable from nowhere is a 404.",
      },
    },
  },
} as const;
