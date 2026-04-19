# Profiles — Managing Multiple Appstrate Instances

- [Layout](#layout)
- [Resolution Order](#resolution-order)
- [Selecting a Profile (Per-Call)](#selecting-a-profile-per-call)
- [When to Infer a Profile From the Prompt](#when-to-infer-a-profile-from-the-prompt)
- [Managing Profiles](#managing-profiles)
- [Cross-Profile Operations](#cross-profile-operations)
- [Gotchas](#gotchas)

For users who pilot multiple Appstrate instances (cloud, self-hosted production, dev, per-project), the skill supports **named profiles** stored in `~/.config/appstrate/profiles/<name>.env`. Each profile is a plain `.env` file containing the three standard vars.

## Layout

```
~/.config/appstrate/
├── default-profile              # one line: the profile name to use when no override
└── profiles/
    ├── cloud.env                # e.g., app.appstrate.com
    ├── local.env                # e.g., self-hosted via ~/.appstrate
    ├── dev.env                  # e.g., appstrate-dev dev instance
    └── <anything>.env
```

Each `<name>.env` file contains:

```
APPSTRATE_URL=...
APPSTRATE_API_KEY=ask_...
APPSTRATE_ORG_ID=...
```

**Permissions**: the `~/.config/appstrate/` directory and every `.env` inside are `chmod 600` / `700`. Never world-readable.

## Resolution Order

When the skill needs credentials, look in this order (first match wins):

1. **`APPSTRATE_PROFILE` env var** — e.g., `APPSTRATE_PROFILE=local bun run agent.ts`
2. **`~/.config/appstrate/default-profile`** — contents = profile name
3. **`APPSTRATE_URL` / `APPSTRATE_API_KEY` / `APPSTRATE_ORG_ID` env vars** — legacy single-instance mode
4. **Project `.env` files** — legacy per-project override
5. **Other coding-agent config dirs** (`~/.claude/.env`, `~/.cursor/.env`, …) — legacy fallback

Profiles are only consulted via steps 1–2. If no `profiles/` dir exists, the skill falls back to the legacy search from step 3 — full back-compat.

## Selecting a Profile (Per-Call)

**Inline for a single command** (no env persistence):

```bash
set -a
source ~/.config/appstrate/profiles/local.env
set +a
curl "$APPSTRATE_URL/api/agents" \
  -H "Authorization: Bearer $APPSTRATE_API_KEY" \
  -H "X-Org-Id: $APPSTRATE_ORG_ID"
```

**Subshell so it never pollutes the current env**:

```bash
( set -a; . ~/.config/appstrate/profiles/local.env; set +a;
  curl "$APPSTRATE_URL/api/agents" -H "Authorization: Bearer $APPSTRATE_API_KEY" -H "X-Org-Id: $APPSTRATE_ORG_ID" )
```

**Via `APPSTRATE_PROFILE`** (resolution expands it):

```bash
export APPSTRATE_PROFILE=local
# now every skill-driven call uses local until unset
```

## When to Infer a Profile From the Prompt

When the user mentions an instance by name or context, resolve to a profile:

| User says                                                   | Profile to use        |
| ----------------------------------------------------------- | --------------------- |
| "on cloud", "en cloud", "on prod", "production"             | `cloud`               |
| "on local", "en local", "my self-hosted", "sur mon install" | `local`               |
| "on dev", "dev instance", "appstrate-dev"                   | `dev`                 |
| No mention                                                  | `default-profile`     |
| "on all my instances"                                       | iterate every profile |

If an inferred profile doesn't exist, list the available ones with `ls ~/.config/appstrate/profiles/` and ask which to use.

## Managing Profiles

### List

```bash
ls ~/.config/appstrate/profiles/
cat ~/.config/appstrate/default-profile
```

### Add

```bash
cat > ~/.config/appstrate/profiles/dev.env <<EOF
APPSTRATE_URL=http://localhost:3000
APPSTRATE_API_KEY=ask_...
APPSTRATE_ORG_ID=...
EOF
chmod 600 ~/.config/appstrate/profiles/dev.env
```

### Change the default

```bash
echo local > ~/.config/appstrate/default-profile
```

### Remove

```bash
rm ~/.config/appstrate/profiles/<name>.env
```

### Rotate an API key

Regenerate in the UI, then overwrite the `APPSTRATE_API_KEY=` line in the profile's `.env`. Permissions stay `600`.

## Cross-Profile Operations

When the user asks to inspect or act across instances (e.g., "list agents on all my instances"), iterate:

```bash
for p in ~/.config/appstrate/profiles/*.env; do
  name=$(basename "$p" .env)
  echo "--- $name ---"
  ( set -a; . "$p"; set +a;
    curl -s "$APPSTRATE_URL/api/agents" \
      -H "Authorization: Bearer $APPSTRATE_API_KEY" \
      -H "X-Org-Id: $APPSTRATE_ORG_ID" | head -c 200 )
  echo
done
```

Use a subshell `( ... )` for each so env isolation is preserved between profiles.

## Gotchas

1. **Don't commit profile files** — they contain API keys. Live under `~/.config/`, outside any repo.
2. **`APPSTRATE_PROFILE` beats `default-profile`** — if you export it in a session for a quick test, remember to `unset APPSTRATE_PROFILE` after, or the override sticks.
3. **Legacy env vars still work** — if a user hasn't migrated, step 3 in the resolution order catches them. Offer migration (create profiles from existing env) rather than error.
4. **Org rotation** — if the user rotates their API key or switches orgs, only the affected profile file needs updating.
5. **Cross-org within one instance** — each profile pins one `APPSTRATE_ORG_ID`. To target a different org on the same URL, add a second profile file (e.g., `cloud-tractr.env`, `cloud-lakaz.env`).
