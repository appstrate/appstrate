# Appstrate Setup Guide

## Step 0 (optional): Self-host your own instance

Using `app.appstrate.com` (cloud)? Skip to Step 1.

To self-host, run the one-liner installer on any host with Docker 20+ and Compose V2:

```bash
curl -fsSL https://get.appstrate.dev | bash
```

The installer generates secrets, downloads images, starts the stack, and waits for health. Re-run to upgrade — existing secrets are preserved. Overrides: `APPSTRATE_VERSION=v1.2.3`, `APPSTRATE_DIR=~/.appstrate`, `APPSTRATE_PORT=8080`.

For supply-chain verification (SLSA provenance via `gh attestation verify` or offline minisign signatures), see `examples/self-hosting/README.md` in the appstrate-oss repo.

After install, your instance is at `http://localhost:3000` (or your `APPSTRATE_PORT`). Sign up in the UI, then continue with Step 1 — set `APPSTRATE_URL` to your deployed URL instead of `https://app.appstrate.com` at Step 3.

## Step 1: Create your API key

1. Go to [app.appstrate.com](https://app.appstrate.com) and sign in
2. In the left sidebar, scroll to the **Application** section (bottom of sidebar)
3. Click **Cles API**
4. Click the blue **Nouvelle cle API** button (top right)
5. Fill the form:
   - **Nom**: a label for this key (e.g., `My Coding Agent`)
   - **Expire dans**: expiration delay (default: 90 days)
   - **Permissions**: leave `Tous les scopes` for full access
6. Click **Nouvelle cle API**
7. **Copy the key immediately** — it starts with `ask_` and is shown only once

## Step 2: Get your Org ID

Once you have your API key, run:

```bash
curl -s "https://app.appstrate.com/api/orgs" \
  -H "Authorization: Bearer ask_YOUR_KEY_HERE"
```

This returns your organizations with their IDs. Copy the `id` of the org you want to use.

## Step 3: Store credentials

Store these 3 variables so your coding agent can access them:

```bash
APPSTRATE_URL=https://app.appstrate.com
APPSTRATE_API_KEY=ask_your_key_here
APPSTRATE_ORG_ID=your-org-id-here
```

Common approaches:

- **`.env` file** in your project root (most universal — works with any tool)
- **Environment variables** in your shell profile (`~/.zshrc`, `~/.bashrc`)
- **Tool-specific secrets** (Cursor settings, IDE env config, etc.)

## Step 4: Verify

```bash
curl -s "$APPSTRATE_URL/api/agents" \
  -H "Authorization: Bearer $APPSTRATE_API_KEY" \
  -H "X-Org-Id: $APPSTRATE_ORG_ID" | head -c 200
```

If you see a JSON response with agents, you're good to go.

## Multiple instances?

If you pilot more than one instance (cloud + self-hosted + dev), skip exporting env vars and use named profiles instead: one `.env` file per instance under `~/.config/appstrate/profiles/`. See `references/profiles.md` for layout, resolution order, and cross-instance patterns.

Quick migration from single-instance setup:

```bash
mkdir -p ~/.config/appstrate/profiles
chmod 700 ~/.config/appstrate ~/.config/appstrate/profiles
cat > ~/.config/appstrate/profiles/cloud.env <<EOF
APPSTRATE_URL=$APPSTRATE_URL
APPSTRATE_API_KEY=$APPSTRATE_API_KEY
APPSTRATE_ORG_ID=$APPSTRATE_ORG_ID
EOF
chmod 600 ~/.config/appstrate/profiles/cloud.env
echo cloud > ~/.config/appstrate/default-profile
```
