// SPDX-License-Identifier: Apache-2.0

export const versionPaths = {
  "/api/version": {
    get: {
      operationId: "getVersion",
      tags: ["Meta"],
      summary: "Running version and update availability",
      description:
        "Returns the running platform build identity (release version + git commit, stamped into the image at build time) and whether a newer release is published on GitHub. The GitHub check is cached server-side (hours-long TTL, rate-limit safe) and can be disabled entirely with `UPDATE_CHECK_ENABLED=false`; it is also inactive on source/dev runs where no release version is stamped. Notification only — upgrading is a host-side operation.",
      responses: {
        "200": {
          description: "Running version and update-check status",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  version: {
                    type: "object",
                    description: "Deployed build identity ('dev' on source runs).",
                    properties: {
                      app: { type: "string" },
                      commit: { type: "string" },
                    },
                    required: ["app"],
                  },
                  update: {
                    type: "object",
                    description: "Update availability, from the cached GitHub release check.",
                    properties: {
                      check_enabled: {
                        type: "boolean",
                        description:
                          "False when opted out via UPDATE_CHECK_ENABLED=false or when the running version is unknown (dev).",
                      },
                      update_available: { type: "boolean" },
                      latest_version: {
                        type: ["string", "null"],
                        description:
                          "Latest published release (no 'v' prefix). Null until a check succeeds.",
                      },
                      checked_at: {
                        type: ["string", "null"],
                        format: "date-time",
                        description:
                          "Timestamp of the last successful GitHub check. Null until one succeeds.",
                      },
                    },
                    required: ["check_enabled", "update_available", "latest_version", "checked_at"],
                  },
                },
                required: ["version", "update"],
              },
              example: {
                version: { app: "1.0.0-beta.38", commit: "5bbe1d9" },
                update: {
                  check_enabled: true,
                  update_available: true,
                  latest_version: "1.0.0-beta.40",
                  checked_at: "2026-07-19T08:00:00.000Z",
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
      },
    },
  },
} as const;
