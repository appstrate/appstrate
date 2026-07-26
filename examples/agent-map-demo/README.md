<!-- SPDX-License-Identifier: Apache-2.0 -->

# Agent map demo

Two agent definitions that exercise every card of the **agent visual map**
(`Carte` tab on an agent), plus a script that recreates them over the public REST
API.

They exist because a local Tier-0 database is disposable: PGlite lives in
`./data/pglite` and a corrupted or wiped directory takes the demo data with it.
Committing the definitions means the demo is a command away instead of a
re-typing exercise.

## Contents

| Path             | What it is                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `rapport-hebdo/` | A furnished agent: two integrations with tool selections, a skill, an MCP server, typed input/output, a timeout, runtime tools |
| `agent-nu/`      | A bare agent — every card empty, which is what shows the map's "add it here" affordances                                       |
| `seed.ts`        | Signs up (or in), creates the org and posts both agents plus one schedule                                                      |

Each agent is a plain `manifest.json` + `prompt.md`, exactly what the API's
create body takes. `seed.ts` reads those files rather than embedding the
definitions, so the files remain the single source of truth.

## Run it

```sh
bun examples/agent-map-demo/seed.ts                        # against localhost:3000
BASE=http://localhost:3300 bun examples/agent-map-demo/seed.ts
```

Then sign in with `map@local.test` / `mapdemo12345` and open
**@mapdemo/rapport-hebdo → Carte**.

Overridable: `BASE`, `DEMO_EMAIL`, `DEMO_PASSWORD`.

## What the demo deliberately leaves broken

`rapport-hebdo` declares dependencies that are **not** satisfied, because that is
what makes the map's diagnostics visible:

- `@appstrate/gmail` and `@appstrate/slack` are declared but not active in the
  application, and have no connection — the toolbox rows carry warnings, and the
  issue counter opens the Connections panel.
- `@mapdemo/mise-en-forme` is a skill that does not exist, so the skills row
  shows up unresolved.

Activate Gmail from the toolbox card's Library block to watch a diagnostic
disappear. Nothing here needs an LLM: the map is a projection of the manifest and
the installation, so it renders fully on an instance with no model configured.
