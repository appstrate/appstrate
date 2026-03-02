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
        example: { error: "FORBIDDEN", message: "Admin access required" },
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
          message: "Too many requests. Please try again shortly.",
        },
      },
    },
  },
} as const;
