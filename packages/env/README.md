# @appstrate/env

Single source of truth for all environment variables, validated with Zod at startup.

## Usage

```typescript
import { getEnv } from "@appstrate/env";

const env = getEnv(); // Cached after first call, fail-fast on invalid config
env.DATABASE_URL; // string (required)
env.LOG_LEVEL; // "debug" | "info" | "warn" | "error" (default: "info")
env.PORT; // number (default: 3000)
```

## Adding a new variable

1. Add the Zod field in `src/index.ts`
2. Update `appstrate/.env.example` with a comment and default value
3. Run `bun run check` to verify

## Key variable groups

- **Database**: `DATABASE_URL`, `BETTER_AUTH_SECRET`
- **S3 Storage**: `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`
- **Redis**: `REDIS_URL`
- **Docker**: `DOCKER_SOCKET`, `PI_IMAGE`, `SIDECAR_IMAGE`
- **SMTP** (optional): `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`
- **OAuth** (optional): `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`
