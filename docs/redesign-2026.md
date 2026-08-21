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

The `error` scenario used to 500 EVERY endpoint, the session included, so it
landed on the login form and no inner screen ever showed its error state — the
scenario was unusable for the thing it exists for. Identity, orgs and
applications now survive it (`ERROR_SCENARIO_SURVIVORS`): the failure a user
actually meets is one request breaking under a shell that still stands. It
found a real one on its first run — the run list said "Aucun run" on a 500.

The chat's own endpoints are fixtured too: a conversation with real turns
(`chatHistory`) and the resume probe (`/sessions/:id/stream` → 204, the real
server's "nothing is generating"). Without those two the lab only ever showed an
EMPTY thread opening on a generation error — the screen the chat is actually
about could not be looked at.

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
┌──────────────────────┬─────────────────────────────────────────────┐
│ [T] Tractr | Default⌄│  Tous les runs                     🔍  🔔   │  56px
├──────────────────────┼─────────────────────────────────────────────┤
│  [▢ Studio][ Chat ]  │                                             │
│  Activité            │                content                      │
│   Dashboard …        │                                             │
│  Construire          │                                             │
│   Agents …           │                                             │
├──────────────────────┤                                             │
│ OT Olivier      ⇤    │                                             │
└──────────────────────┴─────────────────────────────────────────────┘
```

The column reads top to bottom as: whose data → which tool → what you do in it
→ who you are. It took several passes to land there; the ones that were tried
and dropped are at the end of this section, so they are not tried again.

- **The head belongs to the ORGANISATION** — its avatar, its name, the
  workspace beside it, one line, flat. Inside the app, whose data you are in is
  the useful identity; the Appstrate mark is not in the column at all. The rule
  under this band is the header's own, so the sidebar's line and the content
  header's line are one line across the shell (both at 56px — check
  `getBoundingClientRect().bottom` on both, they must match).
- **The switch always ends on a workspace.** Two columns: organisations left,
  the workspaces OF THE ONE BEING EXPLORED right. Clicking an organisation
  opens its workspaces, it does not switch to it — you are never in an
  organisation alone, so a click that switched on its own had to invent the
  workspace to land you in (whichever `useAutoSelect` picked). Org and
  workspace are applied in the same tick, and a changed org lands on the root
  of the product you are in (from the chat, you stay in the chat). The current
  context and the explored one read differently: the current org keeps the
  coral fill, the check and the only gear; the explored one is the highlighted
  row with the chevron into column two. "Add a workspace" hides while you
  explore elsewhere — it would create it in the org you are in.
- **The products are TABS**, not a menu: two of them (three once the Inbox
  lands) and their names are what you choose between. A segmented control names
  them all at once where a menu names one. Plain icons, no coloured tiles — the
  only coloured mark in the column is the organisation's, one line up, and two
  brands inside eight lines of chrome is one too many. Selection is the white
  fill. No rule under the strip: it is its own enclosure. More air above than
  below, so it reads as the head of the navigation rather than the tail of the
  rule above it. In the rail the labels go and the icons stack.
- **Docs & API is not a product** — it is a link out, and the profile menu
  carries it, where people look for documentation by reflex.
- **Search and the bell live in the header**, right end. Global but not
  personal: they answer "find me something" and "what is new" where the sidebar
  answers "where am I". Search is present but DISABLED — the app has no global
  search yet (the reference design has one, see Strategy). Notifications are
  scoped by org AND workspace server-side
  (`services/state/notifications.ts` filters on both), which is why the bell is
  not parked next to the profile: there it would read as "mine" and be wrong.
- **The foot is the identity** — avatar, name, email, opening the profile menu
  — and the collapse control beside it. Collapse changes the column's WIDTH, so
  it belongs at the end of the column, not in the head competing with the
  product name. Usage and Settings are NOT there: both configure the
  organisation and its switcher already carries them (the gear on the row you
  are in, the settings link under the panel). Usage costs one click more, and
  when the Usage page of its own exists it will want a home — that is the
  argument to re-open then.
- **`ShellSidebar` + `ShellHeader`** (`components/shell-frame.tsx`) are written
  once and used by both products; each passes only its own navigation. They
  were extracted after the chat's copy had already drifted from Studio's by a
  font weight.
- Header height is `--spacing-header` (56px), a constant. It used to shrink on
  sidebar collapse while two surfaces subtracted a hard-coded 3.5rem.

Tried and dropped, so they are not tried again:

- **Everything in the header** (product in the brand cell, org chip first in
  the trail). It was the state for weeks and it works; what it costs is a
  header holding a trail and nothing else on screens that publish no trail —
  the dashboard was 56px of bar for one bell.
- **The context as a framed white card.** Good on its own, wrong once the tool
  below was framed too: two stacked cards say the two lines are the same kind
  of thing, and they are not. Rules separate the bands now, not frames.
- **Search and the bell in the brand cell.** They fit, but the line then had
  four things plus two buttons in 256px and the workspace truncated to "Defa…".
- **Org over workspace on two lines.** It gave the workspace a weight the org
  already carries.

## The table

`components/data-table.tsx` + `components/runs-table.tsx`. One table, many
column sets — the reference says it itself: it does not draw four list screens,
it draws `.data-table` and four `--cols` values.

A caller describes its columns and nothing else. Each column is ONE literal
carrying its width, its breakpoint behaviour, its alignment and its content, so
adding a column is one edit rather than the same id typed into five parallel
maps (it was, briefly).

- **Grid tracks, not table layout.** `minmax(0,1fr)` says "take what is left"
  where `table-layout: fixed` needs percentages recomputed at every change.
  **Every track must be content-independent** (px or fr): each row is its own
  grid container, so an `auto` track is measured per row and the columns stop
  lining up — the one thing the table is for.
- **The markup stays a real `<table>`, and every ARIA role is re-declared.**
  Overriding `display` on table elements DROPS their implicit roles in Chrome
  and Firefox; without `role="table"`/`"row"`/`"cell"` a grid-displayed table
  announces as a pile of divs.
- **The row is a LINK**, in the first column that survives the narrow
  breakpoint (a link parked in `#131`, which is secondary, leaves the row
  unclickable on a phone), stretched over the row with `after:inset-0`. That
  overlay is also the trap: it paints over the other cells and takes the HOVER
  with the click, so a native `title` stops firing. Anything that answers to
  the pointer raises itself (`relative z-10`) — the titled ELEMENT, not its
  cell, so the dead zone is the size of the text.
- **Secondary columns drop with their track** below `md`. Both templates ride
  as custom properties on the table; dropping a cell without its track shifts
  every column after it.
- Naming is not the table's business: `use-run-agent-name.ts` resolves what to
  call the agent a run executed and ALWAYS returns a name. Hiding the COLUMN
  must not blank the name — the row's accessible label is built from it.

Runs is the first column set (`dt-runs`): number, agent, status, trigger,
**result**, documents, duration, date. The result column is new — a failed
run's error was invisible on the very screen whose job is to say which one
broke.

Still open on the table, deliberately:

- **Sortable heads.** The reference has them (`.th-sort`, `.th-sort.active svg`
  in `--accent`). `GET /api/runs` takes no sort parameter, so the head would
  either lie or sort one page of fifteen. It waits for the endpoint.
- **Integrations** are the one list still card-only. That page is its own
  (its own tabs, its own client-side search over the loaded catalogue), so it
  is also where a real `lt-search` can land first — the data is already in the
  browser there.
- The heavy scenario pages at fifteen rows like the real screen does, so what
  it proves is pagination and the widest content, not volume in one viewport.
  The 200 rows are still the right fixture: they are what makes "Page 1 sur 14"
  and a long error in a narrow column visible at all.

## The toolbar, and the empty state

`components/list-toolbar.tsx` is a **port of shadcn's `DataTableFacetedFilter` +
`DataTableToolbar`** (the Tasks example,
`apps/v4/app/(app)/examples/tasks/components/` in `shadcn-ui/ui`), which is the
reference implementation for filtering a table in the design system this app is
already built on. Live: <https://ui.shadcn.com/examples/tasks>.

It got there the long way, and the detour is the lesson: two versions of this
file were INVENTIONS. The first put the chosen value on the trigger AND
repeated it as a chip below (the same words twice, on a row of buttons that
changed width as you filtered). The second replaced that with chips carrying
"et" and "ou" spelled out between them, which is a control nobody has ever
shipped. Filtering a list is the most-solved problem in this design system;
none of it was ours to invent.

The pattern, and where it deviates:

- **The filters live BEHIND a button, in a row of their own.** shadcn keeps
  them inline in the bar; that works for a full-width page with two of them.
  Ours sit beside a 256px sidebar, a screen can have three, and their width
  depends on how many values are picked and how long the translations run — so
  the bar spent several rounds either wrapping (flexbox sends the LAST child
  down, which is the end that must not move) or growing machinery to avoid it:
  a ladder of breakpoints, then a ghost row and a `ResizeObserver` to decide
  when to fold. All of that is deleted. One layout at every width, nothing to
  measure.
- **The row opens ITSELF when something is filtering.** A list you did not
  filter yourself — a link someone sent you — has to say why it is short, and a
  badge saying "3" does not say which three. Only the first render decides;
  closing it afterwards is the reader's call and nothing reopens it.
- **The row may take two lines.** That is what a dedicated line is for, and it
  is the difference between a line you opened and a line that appeared because
  the window moved.
- **The search never moves.** It is the one thing you type into, so it stays at
  the left of the bar at every width, and it is the one control there with a
  WHITE background — a field is a surface. (It used to travel into the
  disclosure row with the filters, which was simply a bug.)
- **Three tiers on one row, and the SURFACE is what separates them.** Filters
  and Columns adjust the view, so they are an outline on the canvas: solid grey
  border, no fill, no shadow. The page's own action does something to the data,
  so it keeps a surface — white and slightly raised, or filled when it is a
  create. Reading left to right you can tell a setting from a deed without
  reading a word.
  Note the trap in getting there: shadcn's `outline` variant paints
  `bg-background`, which is WHITE here (our page canvas is its own `--canvas`),
  so every one of them came out as a white pill on grey. Any port of a shadcn
  control onto the canvas has this to check.
- **Dashed stays for the DIMENSION triggers only**, inside the filter row,
  where the metaphor holds: each one is an empty slot you can fill, and its
  border closes once it is filled. The Filters button itself is solid — it
  opens a panel, it is not a slot.
- **The chosen values live INSIDE each dimension's trigger**, up to two named,
  then "N sélectionnés" — shadcn's own rule, and it no longer needs the
  breakpoint that shortened it, since in a row of their own the buttons wrap.
- **The menu is a `Command`**: searchable, square checkboxes, several values at
  once, and a centred "Effacer ce filtre" at the bottom — THIS dimension, which
  is why it is not called what the row's button is called.
- **One "Réinitialiser ✕"** in the filter row once anything is on: the only
  ONE-click way back to the whole list. It is the PAGE's reset, not a loop over
  the filters — see the trap below.
- **A tick adds, an untick removes, and nothing else happens.** This was got
  wrong once and the way it was wrong is worth keeping: "all values ticked
  narrows nothing, so store it as nothing ticked" is true of the RESULTS and
  nonsense as an interaction. Kind has two values, so ticking the second
  silently unticked the first; Scope has one, so its only box could never stay
  ticked at all. A control never reads the results, and never rewrites what was
  asked for.
- **The operators are never written.** Values of one dimension are
  alternatives, dimensions narrow each other — `(statut = échoué OU timeout) ET
(type = agent)`, which is what the query does (`IN (…)` per dimension, `AND`
  between them). No faceted filter anywhere spells that out.
- **The state is in the URL**, pushed, not replaced: a filtered list is what
  people paste to each other, and the rule that gave modals real URLs brings
  the same obligation — Back has to undo a filter. The search is the exception,
  replaced rather than pushed: eight keystrokes would otherwise be eight
  history entries.
- **On a list screen the page's action IS in the bar**, at the right end beside
  the view controls, where shadcn puts "Add task". Screens with no list keep
  theirs at title height.
- **The right end sheds words before icons** as the bar narrows: the labels on
  the filters and columns buttons first, then the label on the page's own
  action — which the CALLER writes with `@…/bar`, the container
  the bar names, so the whole row degrades together. **No overflow menu**:
  shadcn hides its View button and keeps "Add task" whole, and the control a
  screen exists to offer is the last thing that should need a second click to
  find.
- **The count is NOT on the bar — it is under the table**, in the footer with
  the page controls, which is where shadcn keeps it too
  (`data-table-pagination.tsx`). A toolbar is what you act WITH; a footer is
  what the table came to. It also frees the end of the bar that runs out of
  room first. The footer renders for a count alone: the arrows are the option,
  the count is the point.
- Both the count and the column menu reach their places through render props on
  `RunList` (`countLabel`, `toolbar`), because the query and the columns live
  in the list. A page asking for the same rows again to count them is the
  duplicate `GET /api/runs` the dashboard already had to be cured of.

**The search** is answered wherever the data actually is: client-side over
name, description and keywords on the package lists, which hold their catalogue
whole; server-side on the run list through `q`, which matches the agent (scope
and name, as stamped on the run), the error, and the run NUMBER when the query
is digits. One placeholder shape everywhere — "Rechercher des runs…", the verb
and what the table holds, not the fields it matches.

**The columns are the reader's** (`DataTableViewOptions` in the reference).
Hiding is per TABLE and remembered, so the runs table keeps its columns on the
runs page, in an agent's tab and in the dashboard card alike; the last visible
column cannot be hidden. That is why a column set is a HOOK the caller holds
(`useRunColumns`, `useScheduleColumns`, `usePackageColumns`) rather than a list
built inside the table: the menu names the columns and the table draws whatever
is left, so both have to be looking at the same array.

Still missing from the original, for want of an endpoint: **the per-value
counts in the filter menu.** shadcn reads them off the rows it holds
(`column.getFacetedUniqueValues()`); ours are paginated server-side, so a count
would describe the page rather than the list.

The empty state is the redesign reference's (`empty-state`): the icon in a
raised badge at the centre of three rings. A 40px glyph at 40% opacity on an
empty card read as a rendering failure rather than as a state someone designed.
Same props, so every screen that had one got it.

**An empty list and a filtered list that finds nothing are different
sentences.** The run screen says "no run matches these filters" and hands the
filters back; only a genuinely empty list says there are no runs. The filters
themselves never read the results: they stay clickable whatever the table
holds.

## Schedules

`components/schedules-table.tsx` — the second column set (`dt-sched`): the
schedule and the agent it fires, the cron, whether it is on, next, last, and
who it runs as.

The card it replaced was a row wearing a card's border, plus a dashed strip
underneath previewing the next run. Stacked, no two rows agreed on where
anything was, and the one question the screen answers — when does this fire
next — moved left and right depending on which badges came before it.

Two things the columns fixed rather than moved:

- **The agent is on every row.** The card only showed it inside the next-run
  strip, so a disabled schedule never said which agent it fires.
- **A paused schedule shows no next run.** The database keeps `next_run_at`
  when a schedule is disabled; printing it promises a run that is not coming.

## Packages, and the two views

`components/packages-table.tsx` — the third column set, over the `CardItem` the
cards already take, so agents, skills and MCP servers switch views without
either side learning anything about the other.

The reference keeps CARDS for this family (`ac-*`, `rcard-*`) and puts the table
beside them behind a `view-toggle`, and it is right to. A card carries a
description at a length you can read, which is what choosing an agent needs;
the table is for the other moment — twenty of them, and you want to know which
are system, which are running, at what version, down one column.

- The preference is in **localStorage, not the URL**: a view is a habit, and a
  link to a list should open on the reader's habit rather than impose the
  sender's. One store for the whole family — someone who wants the table for
  agents wants it for skills.
- **No result count on that toolbar.** The count answers "how many did the
  filters leave"; with nothing filtering it only repeats what is on screen.
- The count, when there is one, is passed as the CALLER'S OWN WORDS. A toolbar
  that formats "3 runs" for everyone is a toolbar that will one day say it
  about agents — it did, for about ten minutes.

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
- **The header's right end stays personal.** The bell and the profile do not
  move to make room for CTAs: that corner has to read the same on every screen,
  and the free space is between the trail and the bell, which is where the chat
  put its context tabs. (The SHELL header, that is. Where a page's own actions
  go is the next entry, and it changed.)
- **On a list screen, the page's actions sit at the right end of the TOOLBAR
  row**, beside the view controls — where shadcn puts "Add task". Every table
  screen then keeps its controls and its actions in the same corner, and the
  title row stays clean. Screens with no list keep theirs at title height, in
  `PageHeader`'s `actions`. This revises the earlier call ("page actions have a
  home, the `actions` slot at title height"), which was made before there was a
  toolbar to put them on.
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

- **N URL updates in one tick collapse into one, and the last wins.** The
  toolbar's "Réinitialiser" cleared each filter in turn, so three
  `setSearchParams` all computed from the same committed location: the status
  went and the scope and the kind stayed, on a button that looked like it had
  worked. Anything that changes several query parameters at once has to be a
  single update.

- **`key` resets state by REMOUNTING, and takes the subtree's UI state with
  it.** Resetting the run list's page on a filter change that way closed the
  toolbar's open menu on every tick, because the toolbar renders inside the
  list. Derive the reset instead (`page` from a filter signature) whenever
  something interactive lives in the keyed subtree.
- **`placeholderData: (prev) => prev` keeps the previous rows for ANY key
  change**, not just paging. Ticking a filter left a whole unfiltered page
  sitting under a chip that was already on screen. Compare the previous key and
  keep the rows only when the offset is what moved.

- **`<button>` centres its flex content by default.** Rows with a subtitle sat
  left of rows without one; the brand cell drifted to the middle of the sidebar.
  Add `justify-start`.
- **A scroll container inside the content column desynchronises the header.**
  The header kept the full width while the content lost the scrollbar's 15px.
  The scroll belongs on `SidebarInset`, header sticky inside it.
- **Fields inside a popover** inherit the base layer's input styling (border,
  padding, focus ring) and have to undo it explicitly.
- **Every `button` gets `px-3 py-1.5` from the base layer.** An icon button has
  to reset `p-0` or the padding eats the icon: an 18px glyph in a 32px box was
  rendering 8px wide, and it reads as "the icon is too small" rather than as a
  padding bug.
- **A link inside a button is invalid markup** — the switcher gears had to move
  out of the row button and sit beside it.
- **The MCP browser and the dev server get orphaned** between sessions. Kill
  `chrome-profile-beta` and remove its `Singleton*` locks if the MCP says the
  browser is already running. Same for Vite: check `lsof -iTCP:5173-5180` and
  kill the strays before starting, or the lab answers on a port you are not
  looking at.
- **A stretched link overlay eats hover, not just clicks.** `after:inset-0`
  over a table row means every native `title` under it stops firing. Raise the
  titled element with `relative z-10`; raising the whole cell instead makes the
  column dead to clicks.
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

## Strategy — what the reference actually covers, and the order to take it

Read the reference by its class families, not by scrolling it
(`grep -oE "^\.[a-z]+-" satellites/redesign-2026/styles.css | sort | uniq -c | sort -rn`).
What that shows:

- `rd-*` (82 classes) — the RUN DETAIL. By far the most worked-out screen in the
  reference, and the one the redesign has not touched at all.
- `dt-*` — a DATA TABLE with named columns (`dt-c-num`, `-name`, `-status`,
  `-actor`, `-cron`, `-trigger`, `-ver`, `-time`, `-result`) plus `dt-runs`,
  `dt-agents`, `dt-sched`, `dt-intg`. The reference does not draw four list
  screens; it draws ONE table and four column sets.
- `lt-*` — the list toolbar above it (search, chips, clear, actions).
- `cmdk-*` — a COMMAND PALETTE exists in the reference. That is what the
  disabled search icon in the header is waiting for.
- `empty-*`, `rcard-*`, `sched-*`, `lib-*`, `mem-*`, `log-*`, `term-*` — empty
  states, run cards, schedules, library, memory, logs, terminal.

So the strategy the reference itself suggests:

1. **The shell is done. Freeze it.** It was iterated hard and the returns are
   now small. Reopen only when a screen shows a real defect, not on taste.
2. **Take PATTERNS, not pages.** `dt-*` says it plainly: build the table once
   with a column contract, then Runs, Agents, Schedules and Integrations are
   column sets. Six page-by-page passes cost more and drift more. Same for the
   list toolbar, the empty state, the detail layout.
3. **Promote to `@appstrate/ui` on the second use**, as `shell-frame` was. A
   component that stays local until the third screen is a component whose
   variants have already diverged.
4. **Prove each pattern in the lab on all four scenarios** before applying it
   anywhere else. Nominal is the one that lies: `heavy` found the unvirtualised
   list, `empty` found the onboarding bounce, `error` finds the banner
   placements. A pattern applied to six screens from its nominal state alone is
   six screens to fix.
5. **Order**: the table pattern (Runs first, most looked at) — DONE — then the
   list toolbar and the reference empty state — DONE — then the remaining
   column sets: schedules DONE, packages (agents, skills, MCP servers) DONE
   behind the `view-toggle`, integrations left. Then run detail (`rd-*`, the biggest single screen), then the command
   palette (it gives the header's search icon its reason to exist), then Usage
   — the only screen with no reference at all, which is exactly why it is not
   first.
6. **Where the reference is silent, derive rather than invent**: grey canvas +
   white cards, the control IS the setting, excursion → modal / destination →
   page. Those four decide most cases on their own.
7. **When the reference contradicts what the screen shows, the screen wins** —
   it already happened once, with `:root` against the saved state.
8. **Merge in slices.** The branch is 31 commits and the shell is independent
   of the screens. A shell-only PR can land before the first table exists;
   keeping everything for one big-bang merge makes the review worse and the
   revert coarser.

## Open

- **`?user=me` combines now** (`listGlobalRuns({ mine })`). It used to take a
  separate query that dropped `kind`, `status` and the date range on the floor,
  so the screen showed two filters as active and the server applied one — the
  toolbar could not have been drawn honestly on top of it. One behaviour change
  came with it: an END-USER passing `chat_session_id` now gets nothing rather
  than their own runs, because chat sessions belong to members and the filter
  is no longer ignored for them. That is the correct answer to the question
  asked, but it is a change.
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
- **Per-org colour and LOGO** — the design gives each org a colour; the data
  model has neither. Deferred by decision, twice. The shape is decided for when
  it comes back: a dedicated column (identity read on every render, and
  `GET /api/orgs` is the boot request that must carry it), stored LOCALLY
  through the existing upload chain (`POST /api/uploads` → S3/MinIO/FS). A URL
  is an IMPORT convenience — "take the favicon of my site", fetched server-side
  through the SSRF floor (`@appstrate/core/ssrf`) and then stored locally —
  never a storage mode: a third-party URL makes every employee's browser call
  that third party on every page, breaks in a closed self-hosted install, and
  takes the org's identity down with it the day the site is redone. The cost is
  not the column, it is validation, a resized variant, deletion with the org,
  and the settings screen.
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
- **The thread sits on the canvas, not on white.** It was the one screen in the
  product that was flat white: `bg-background` is shadcn's COMPONENT surface,
  and a full-page thread is a page. Everything that was a surface became a white
  card on the grey — the composer and the tool cards already were, the user
  bubble and the welcome suggestions were not (`bg-muted` is a hollow on white
  and reads as a smudge three points of luminance from the canvas). The context
  panel stays white: it is a panel laid ON the canvas, like a dialog.
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
