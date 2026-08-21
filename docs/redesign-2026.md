# UX/UI redesign — state, decisions, and what is left

Branch `feat/redesign-lab`, worktree `worktrees/redesign-lab`. Reference
stylesheet exported out of Claude Design and kept outside the repo at
`satellites/redesign-2026/styles.css`.

`git log origin/main..HEAD` says what each commit changed, at length. This file
says where things stand, why the non-obvious calls were made, and what is still
open — so the work can be picked up cold.

## Running it

```bash
cd apps/web
bun run dev:lab   # fixtures only — no API, no database, no Docker
bun run dev:hmr   # hot reload against a local backend
bun run dev       # unchanged: build-and-watch, served by the API
```

The dev server is best launched detached (`(nohup bun run dev:lab > log 2>&1 &)`)
— background shells get SIGTERM'd between turns otherwise.

**The gate is `bun test` + `bun run check`, not typecheck and build.** A locale
guard (`apps/web/src/locales/test/locale-keys.test.ts`) fails on orphan i18n
keys, and it caught thirteen of them because typecheck and build were green and
nobody ran the tests. Run them.

Two things about that gate in this worktree:

- **`bun run check` needs a `.env`** — `detect:breaking` boots the API's env
  schema, so without one it fails on missing secrets and never reviews a line of
  the change. Copy the mother repo's (`../../appstrate-main/.env`); it is
  gitignored. It was missing `CONNECT_SESSION_SECRET`, added by hand.
- **`bun test` from the root is not green on a clean checkout.** The
  MITM/sidecar suites (`runtime-pi/sidecar/test/…`) fail locally for want of a
  CA bundle — 15/15 fail on `e18faa6b1` with no changes applied. Verify a
  suspicious failure by stashing rather than assuming, then run the touched
  packages (`bun test apps/web packages/ui packages/module-chat`) for a signal
  you can read.

## The lab

`src/lab` answers every backend call in the browser from fixtures. The scenario
switcher (bottom right) re-serves the same screens as nominal, empty, heavy
(200 rows) and error — the empty one lands on the real onboarding flow.

Two things that are easy to get wrong:

- The patch is on `window.fetch`, not the typed client's middleware. The first
  screen has three independent callers — better-auth, openapi-fetch, and
  hand-rolled SSE/upload fetches — and only one goes through `api/client.ts`.
- It is injected by a serve-only Vite plugin as the module script _before_
  `/src/main.tsx`, because both HTTP clients capture `globalThis.fetch` when
  they are constructed at module-evaluation time. Anything `main.tsx` does is
  already too late.

Fixtures are typed as the response type the OpenAPI spec generates for the
endpoint that returns them, so a backend shape change fails `typecheck` on the
fixture. `src/lab/install.ts` also supplies `window.__APP_CONFIG__` with modules
on — without it the chat, billing and webhooks surfaces are invisible in the lab.

A missing fixture logs `[lab] no fixture for GET /api/… → 404`. That is the
console telling you about a hole, not a bug.

Handlers receive the request's headers, so an org-scoped list can answer for the
org that was ASKED for rather than the one the app is in — `applicationsByOrg`
gives Tractr three workspaces and Appstrate one, which is what makes the
switcher's second column provable.

## The target, read from the SAVED design state

`app.jsx` in the design project pins `layout: "droit"` and `fondsGris: true`,
and those two override everything the stylesheet declares at the top. The CSS
still contains the earlier "floating white card" variant; the JSX is what
decides. Reading `:root` alone will send you the wrong way — it did once.

Target: grey (#FAFAFA) everywhere — canvas, sidebar, header — with white cards
on top; content flush, no gutter card, no 16px top radius.

## Shell

```
[⚡] Studio ⌄  │  [T] Tractr | Default ⌄  /  Tous les runs        🔔  OT
   product           org | workspace            where you are
```

- **Product switcher** in the brand cell (Studio / Chat / Docs & API), not a
  nine-dot grid top-right: you clicked right and the word on the far left
  changed, and that corner holds personal things. The grid becomes right again
  past roughly five products.
- **Org/workspace chip** first in the trail. Deliberately NOT shaped like the
  segments beside it: a breadcrumb segment means "go up a level", cheap and
  reversible; this one replaces the whole context. Coloured avatar plus an
  up/down chevron, never a right chevron.
- **The switch always ends on a workspace.** Two columns: organisations left,
  the workspaces OF THE ONE BEING EXPLORED right. Clicking an organisation
  opens its workspaces, it does not switch to it — you are never in an
  organisation alone, so a click that switched on its own had to invent the
  workspace to land you in (whichever `useAutoSelect` picked). Org and
  workspace are then applied in the same tick, and a changed org lands on the
  root of the product you are in (from the chat, you stay in the chat).
  The current context and the explored one read differently: the current org
  keeps the coral fill, the check and the only gear; the explored one is the
  highlighted row with the chevron into column two. "Add a workspace" hides
  while you explore elsewhere — it would create it in the org you are in.
- **Nav** groups by what you are DOING: Activité (schedules included — a
  schedule is upcoming activity) and Construire.
- **Meta block** at the sidebar foot: Usage, Paramètres. No credits gauge — a
  permanent bar spends attention every second on a number read every few weeks.
- Header height is `--spacing-header` (56px), a constant. It used to shrink on
  sidebar collapse while two surfaces subtracted a hard-coded 3.5rem.

## Tokens

- **`--background` stays WHITE.** In shadcn it is the COMPONENT surface —
  dialogs, sheets, toasts, outline buttons, the active tab pill — and the
  redesign keeps those white on the grey. The page canvas is its own
  `--canvas` token. Painting `--background` grey turns every dialog grey.
- Names do not map one-to-one: the design's `--accent` is the BRAND blue and
  lands on `--primary`; shadcn's `--accent` is the hover surface and takes the
  design's `--bg-alt`.
- **Dark mode is derived, not ported** — the design defines no dark palette.
- `--spark` (logo coral) is chrome-only: notification count, profile avatar.
  Never a primary action, which is what the blue means.
- `--primary-soft` / `--spark-soft` are the switcher's selection fills, so the
  two dimensions read apart at a glance.

## Settings

Three surfaces, one rendering: **organisation**, **workspace**, **account**
(preferences). All three are routed modals over the page you were on.

- **A real URL.** The previous location rides in navigation state
  (`lib/modal-route.ts`); the main route tree renders THAT location while the
  overlay tree renders the settings route. Opened cold — pasted link, reload,
  new tab — the dashboard stands in underneath, so there is no page-shaped
  variant to keep looking like the modal. The settings routes therefore live in
  the overlay tree ONLY.
- **`NavigateKeepingState`** exists because a plain `<Navigate replace>` drops
  navigation state: `/org-settings` bounced to `/org-settings/general` and the
  overlay silently became a full page.
- Both panes scroll, the dialog itself never does. Nested scrolling is what
  makes these surfaces confusing, not scrolling.
- On a phone the rail becomes a select at the top of the content.
- **Rail head** = "PARAMÈTRES" over the NAME of what is configured. Every group
  keeps its label, one-group surfaces included: the label states the KIND where
  the head gives only the name ("Tractr" does not say it is an organisation),
  and it keeps the three surfaces built the same way. A group-count rule was
  tried and reverted — it optimised inside a surface and cost consistency
  between them.
- **Workspace settings are their own surface**, not a section of the org's:
  everything under them is scoped by `X-Application-Id`. Both are opened by the
  gears on the switcher rows, and the gear only appears on the CURRENT org or
  workspace — configuring one you are not in would have to switch context
  silently first.
- The four **developer** screens (API keys, OAuth clients, End-Users, Webhooks)
  are one family, all org+workspace scoped. Two of them used to be in the main
  nav while two were already in settings.

## Form pattern

`components/settings/setting-row.tsx` — `SettingsGroup` + `SettingRow`, label
and explanation left, control right. The rule it encodes:

> **The control IS the setting.** A field you type in, a dropdown you open, a
> toggle you flip — never a value with an Edit button beside it, which puts two
> clicks and a mode change between the user and a one-word change.

`InlineTextSetting` commits on blur or Enter, reverts on Escape. It is
uncontrolled and keyed on the incoming value, NOT mirrored into state: the
mirror needs an effect to follow the server, which the Rules-of-React gate
rejects (`react-hooks/set-state-in-effect`).

Converted so far: the organisation name. The rest follow screen by screen.

## Terminology

"application" → "espace de travail" / "workspace" in the UI, EXCEPT the eight
strings that mean an EXTERNAL OAuth application ("les applications qui
l'utilisent", "Applications clientes", the hosted-connect message an end-user
reads, the provider-side OAuth app). Code identifiers and API fields are
untouched — this is vocabulary, not a data model change.

## Judgments the product owner has already made

Not preferences to guess at — calls made explicitly during the work, with the
reason each time. They recur, so they are worth knowing before proposing
something that contradicts one.

- **Consistency between screens beats saving a line inside one.** A group label
  on a single-group surface repeats the head, but removing it made the three
  settings surfaces stop looking like the same system. The label stays. A
  group-count rule was tried and reverted for exactly this.
- **A concept has to be visible to be learned.** The workspace level shows even
  when an org has one, because a level nobody ever sees is a level nobody
  learns. Its menu ends on a way to create one rather than a dead end.
- **Duplication is fine when it follows habit.** Documentation sits in both the
  product switcher and the profile menu: people look for help in the profile
  menu by reflex, and a second door costs less than a first door nobody finds.
- **Nothing permanent in the navigation for a number read every few weeks.**
  The credits gauge was removed on those grounds; it belongs behind Usage.
- **Direct manipulation in forms.** No Edit button revealing a field. Fields,
  dropdowns and toggles, Notion-style rows, as a systematic pattern.
- **A modal must have a URL.** Non-negotiable — support has to be able to say
  "open this", and back has to work.
- **On a phone the menu is a dropdown at the top**, never a side rail.
- **URLs may move in a redesign.** Redirects, then move on.
- **Words matter.** "espace de travail" over "application"; the terminology pass
  was requested before any of the screens using it were touched.

On how the work goes:

- References get sent as screenshots (Notion, Fleet, Coolify, LangSmith) and the
  expectation is to steal the specific detail that applies, not the whole thing
  — and to say which detail and why.
- "Qu'est-ce que t'en penses" means a recommendation with its reason, not a
  survey of options. Disagreeing is expected; being talked out of it is fine.
- The dev server is not run by hand. Launch it, keep it alive, verify the thing
  itself rather than asking for a look.
- The two-axis code review runs after each substantive block.

## Traps hit more than once

- **`<button>` centres its flex content by default.** Rows with a subtitle sat
  left of rows without one; the brand cell drifted to the middle of the sidebar.
  Add `justify-start`.
- **A scroll container inside the content column desynchronises the header.**
  The header kept the full width while the content lost the scrollbar's 15px.
  The scroll belongs on `SidebarInset`, header sticky inside it.
- **Fields inside a popover** inherit the base layer's input styling (border,
  padding, focus ring) and have to undo it explicitly.
- **A link inside a button is invalid markup** — the switcher gears had to move
  out of the row button and sit beside it.
- **The MCP browser and the dev server get orphaned** between sessions. Kill
  `chrome-profile-beta` and remove its `Singleton*` locks if the MCP says the
  browser is already running. Same for Vite: check `lsof -iTCP:5173-5180` and
  kill the strays before starting, or the lab answers on a port you are not
  looking at.
- **Vite does not hot-reload an edit inside `packages/`** the way it does one in
  `apps/web`. A behaviour change in `packages/ui` that "did not work" needs a
  hard reload before you believe it.

## Process

- Run the **two-axis code review** (`/code-review <fixed-point>`, Matt Pocock's
  skill) after each substantive block. It runs Standards and Spec as parallel
  sub-agents and reports them separately.
- Its findings need checking, not applying. On the first run it read the
  design's `:root` default instead of the saved state, counted decisions taken
  later in the session as missing requirements, and called the lab harness scope
  creep. It also found a failing test nobody had run.

## Open

- **Usage page**, scoped by user: observability, not billing — who spends what,
  on which agent, with which model, for the agents a user can reach.
  `/api/runs` already accepts `start_date` / `end_date` / `user=me`, and each
  run carries `cost`, `token_usage`, `model_label`, `user_name`, `agent_name`,
  so a v1 aggregates client-side. That does NOT scale past a few thousand runs;
  a server-side aggregate endpoint comes after the shape is agreed.
- **Remaining settings screens** to the form pattern: storage, MCP connect,
  danger zone, and the workspace OAuth-domains form which still has its own
  Save button.
- **Grey depth.** #FAFAFA is 2% off white, faithful to the design but very
  quiet. One token if it should be deeper.
- **Per-org colour** — the design gives each org a colour, the data model has no
  such field. Deferred by decision.
- **Library browsing** (skills, integrations, templates) reuses `PanelDialog`.

## Chat

The chat has its own shell — `apps/web/src/modules/chat/chat-shell.tsx`. Its
routes sit beside MainLayout's rather than inside them, and the
`setOpenTransient(false)` trick that collapsed the Studio sidebar on mount is
gone (so is the setter — it had no other caller).

It does not borrow Studio's navigation, it borrows the FRAME both products
share: `components/shell-frame.tsx` holds `ShellSidebar` (brand cell with the
product switcher, meta block, collapse control) and `ShellHeader` (56px, the
trail, bell, profile). Each product passes only what is its own — Studio its
navigation, the chat its conversations. Written once, so the two cannot drift;
they already had, by one font weight, when the chat kept its own copy.

- **The list and the title left the module.** `ChatPage` rendered both, which
  is why the chat had two sidebars and two stacked bars. They are shell
  furniture — the list IS the navigation, the title IS where-you-are — so the
  module exports them (`ChatConversationList`, `ChatConversationTitle`) and the
  shell raises the chat's two contexts once, over everything. One sessions
  query feeds the list, the title and the thread. What is left in `ChatPage` is
  the thread.
- **The title is published to the breadcrumb store**, like every other page's
  trail, not drawn by a second breadcrumb. `ChatTitleCrumb` publishes it only
  when the conversation is KNOWN — a cold load or a deleted conversation costs
  no segment at all, which beats a segment carrying a made-up name. The
  separator ships with the segment, so nothing dangles either way.
- **Its own open state**, `useChatSidebarStore`, persisted under its own key.
  Two surfaces, two preferences — and Studio's is then left strictly alone,
  which is what the transient setter was working around.
- **The mobile drawer is the shadcn Sheet**, not the module's hand-rolled one.
  Picking a row closes it, from `SidebarMenuButton` itself: on a phone the
  drawer covers the very screen it just navigated to. Studio had that bug too,
  so both products got the fix. The in-row rename and delete buttons are not
  menu rows, so they still work with the drawer open.
- **The list speaks the bundle**, not hard-coded French: `list.*` in
  `chat.json`, plural families for the relative-time column. It sits beside an
  i18n'd Studio nav; half a translated sidebar is worse than none.
- **`heavyChatSessions`** (200 rows, same volume as the other heavy fixtures)
  makes the "Charge" scenario exercise what the sidebar has to hold. The list
  is not virtualised — that is the point of the fixture.
- `useChatUnreadCount` still has no consumer — it drove the nav badge that left
  with the chat.

Open on this surface:

- **The header is tight on a phone**: chip + title + the context panel's four
  tabs + bell + profile. Nothing overflows, but one "Contexte" button instead
  of four tabs would breathe. Left as is until it actually bothers someone.
- **Every row exposes rename and delete to the keyboard** (they are only
  visually hidden), so tabbing through a long history is three stops per
  conversation. True before the move; the longer list makes it worth naming.
- **The title still opens on a pencil**, not the field itself — the one place
  the form pattern's rule is not applied. A breadcrumb is not a form, so it may
  be right; it is at least worth deciding on purpose.

## Rule of thumb that decided several of these

**Excursion → modal. Destination → page.** Settings and library browsing are
excursions: you go in, change or pick one thing, come back. Usage is a
destination: you open it, choose a period, compare, dig.
