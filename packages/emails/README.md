# @appstrate/emails

Email template registry with locale support and cloud override mechanism.

## Usage

```typescript
import { renderEmail } from "@appstrate/emails";

const { subject, html, text } = renderEmail("verification", {
  url: "https://app.example.com/verify?token=abc",
  locale: "fr",
});
```

## Supported email types

| Type             | Trigger                          |
| ---------------- | -------------------------------- |
| `verification`   | User signup (email verification) |
| `invitation`     | Organization invitation          |
| `magic-link`     | Magic link sign-in               |
| `reset-password` | Password reset                   |

## Locales

French (`fr`, default) and English (`en`).

## Cloud overrides

The cloud module can replace default templates at boot via `registerEmailOverrides()` for branded emails.
