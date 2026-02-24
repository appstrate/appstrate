/**
 * Reusable OpenAPI response definitions.
 */
export const responses = {
  Unauthorized: {
    description: "Missing or invalid authentication",
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/Error" },
        example: { error: "UNAUTHORIZED", message: "Invalid or missing session" },
      },
    },
  },
  Forbidden: {
    description: "Insufficient permissions",
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/Error" },
        example: { error: "FORBIDDEN", message: "Acces reserve aux administrateurs" },
      },
    },
  },
  NotFound: {
    description: "Resource not found",
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/Error" },
        example: { error: "NOT_FOUND", message: "Resource not found" },
      },
    },
  },
  ValidationError: {
    description: "Validation error",
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/Error" },
        example: { error: "VALIDATION_ERROR", message: "Field is required" },
      },
    },
  },
  RateLimited: {
    description: "Too many requests",
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/Error" },
        example: {
          error: "RATE_LIMITED",
          message: "Trop de requetes. Reessayez dans quelques instants.",
        },
      },
    },
  },
} as const;
