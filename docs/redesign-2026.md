# UX/UI redesign — state, decisions, and what is left

Branch `feat/redesign-lab`, worktree `worktrees/redesign-lab`. Reference
stylesheet exported out of Claude Design and kept outside the repo at
`satellites/redesign-2026/styles.css`.

`git log origin/main..HEAD` says what each commit changed, at length. This file
says where things stand, why the non-obvious calls were made, and what is still
open — so the work can be picked up cold.

**Picking it up cold, read in this order:** "How the work goes" just below,
then **"Open", which now opens on NEXT, IN ORDER**: the numbered blocks that
are the work, written for someone with no other context. Then "Form pattern",
which the first of those blocks is entirely about, and "The grammar", which
frames the rest. The sections in between describe what is already built, and are
reference rather than reading.

This file is the only handover. Nothing needed to continue lives in any agent's
memory, on purpose: it has to be possible to hand this to a different tool and
have it pick up where the last session stopped.

## How the work goes

The rules that are not about the design but about doing the work. They live
here rather than in whatever message starts a session, because a rule that has
to be re-typed to survive is a rule that will be forgotten once.

- **Run the lab yourself, detached, and leave it up.** Olivier does not manage
  dev servers. `(nohup bun run dev:lab > log 2>&1 &)` from `apps/web` — see
  "Running it" and "The lab".
- **If the MCP browser's lock is held by another session, do not kill
  anything.** There is a door beside it, described in "The lab": Playwright
  drives Chrome STABLE with a throwaway profile, which shares nothing with the
  locked one. Waiting for that lock is what left half this branch unlooked at.
- **Measure the DOM, do not only look at screenshots.** A capture at 1440 shows
  nothing; `getBoundingClientRect` per cell across a sweep of widths is what
  found a column crushed to 6px. Read a rendered hex off a canvas pixel rather
  than converting oklch by hand — that was several points wrong both times.
- **A screen with no fixture is a screen nobody looks at.** Six holes were
  filled in two days, and each one had been hiding a screen that could only
  ever be seen failing. If the screen you are working on errors in the lab,
  write its fixture before concluding anything about how it renders.
- **The gate is `bun test` + `bun run check`**, not typecheck and build. The
  guards catch what the eye does not: orphan i18n keys, the hooks rule, and the
  column-tier arithmetic.
- **Run `/code-review <fixed-point>` after each block, and CHECK its findings
  rather than applying them.** On this branch it found a real design defect and
  proposed two fixes that were wrong.
- **Before drawing a control, read the shadcn source for it.** `packages/ui` is
  shadcn. Twice a control was invented whose answer already existed there —
  see "The toolbar", which is the most expensive lesson in this file.
- **Update this file in the SAME commit as the change it describes**, decisions
  and mistakes alike. Two of the counts in "The grammar" were wrong for a day
  because the doc was written from what was intended rather than from what was
  measured.
- **Answer Olivier in French.** The doc and the commits stay in English.

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

**The panel is the place for a dial when one number has to be JUDGED rather
than reasoned about.** The grey depth was settled that way on 21 August: three
values in the panel, applied in place without a reload (a reload loses the
scroll, and with it the comparison), carried across scenarios and widths until
the eye decided. Then the dial was deleted with the decision — it was an
instrument, not a setting, and the answer lives in "Judgments the product owner
has already made". Two things it taught, for the next one: apply WITHOUT a
reload, and read the rendered hex off a canvas pixel rather than converting
oklch by hand, which was several points out both times it was tried.

**Looking at it when the MCP browser is taken.** That lock belongs to whichever
session grabbed Chrome Beta first, and waiting for it is what kept every screen
since the table unseen. It is not the only way in: Playwright drives Google
Chrome STABLE with a throwaway profile (`chromium.launch({ channel: "chrome" })`),
which shares nothing with the locked profile. The scenario is `localStorage`
(`appstrate-lab-scenario`), so `addInitScript` sets it before the app boots, and
one script then walks every screen × scenario × width unattended. Measuring the
DOM (`getBoundingClientRect` per cell across a sweep of widths) is what found the
crushed columns; a screenshot at 1440 shows nothing wrong.

**That script is in the repo now** (22 August), because eleven of them had been
written into session scratchpads over three days and every one was thrown away,
so each session rewrote the method from this paragraph and no sub-agent could
run it at all:

```bash
bun run lab:shots     # screens × scenarios × widths → PNGs, and the guard below
bun run lab:measure   # one table's real geometry across a sweep of widths
```

`e2e/lab/`, not `apps/web/scripts/`, for one boring reason: `@playwright/test`
resolves from the `e2e` workspace and nowhere else, and putting it under
`apps/web` would mean a dependency and a lockfile edit on a fifty-commit
branch. Parameters are environment variables (`LAB_URL`, `LAB_SCREENS`,
`LAB_SCENARIOS`, `LAB_WIDTHS`, `LAB_ROUTE`, `LAB_SELECTOR`, `LAB_OUT`). It is
not application code, it never ships, and it deserves no abstraction.

**`lab:shots` is also the FIXTURE GUARD.** `mock-fetch` already logs
`[lab] no fixture for GET /api/…`; the script listens for that line and exits
non-zero, naming the endpoint and what to do. Six times in three days a screen
was migrated, opened, and found showing an error instead of a rendering, and
every time a human had to notice. On its first run it found three more, and one
of them had already been MISREAD into this document as fact (see "Open").

**Its screen list grew the same day** to the two DETAIL pages, because the
compact lists live on them and nowhere else: an agent's Connexions and Mémoire
tabs, and a run's. Both were entirely unfixtured — eleven endpoints between the
two, the agent package itself included — so the memory panel and the connection
picker had never once been seen with anything in them. The reading that
reframed step A.2 was only possible after that, and it found three different
things where the plan said one.

The integration catalogue is a permanent lab screen now
(`/integrations?catalogue=1`). It covers the addressable `PanelDialog` itself,
not only the collection behind it, so the catalogue's cards, filters, empty and
error states stay visible at desktop and phone widths.

The guard watches the browser rather than scanning the source, and that is the
whole design. The obvious version greps the hooks for their endpoint strings;
it does not hold, because the SPA reaches the API in FOUR shapes and only two
name their path in the source. `$api.useQuery("get", "/api/x")` and
`client.GET("/api/x")` do; the template-literal form in `hooks/use-packages.ts`
builds its path from a variable, and better-auth fetches
`/api/auth/get-session` from inside its own client, where the SPA never writes
the string — and that one is the first request the app makes. A scan misses
both. Watching the fetch misses neither, and needs no hand-maintained list of
endpoints, which is the thing that would drift. The one list it does carry is
of SCREENS (`e2e/lab/screens.mjs`), which
is a coverage claim a human makes on purpose, not a mirror of the API.

`lab:measure` has a blind spot that a defect walked straight through on the day
it was committed: it measures COLUMNS, not what is inside them. A cell whose
content refuses to shrink can eat a column that measures perfectly. **Measure
AND look.**

**The `error` scenario now lets a DETAIL page stand** (22 August). It already
spared identity, orgs and applications so the shell would survive; the same
reasoning goes one level in, and the resource a detail page is ABOUT survives
too. Without that, the page itself 500s and you get its page-level error, so no
panel on it ever draws its own — the memory panel's failure state was
unreachable in the very scenario that exists to show failure, and so was the
OAuth clients table's. Now the header stands and each tab shows what broke
inside it.

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

- **Grid tracks, not table layout.** `minmax(<floor>,1fr)` says "take what is
  left, but never less than this" where `table-layout: fixed` needs percentages
  recomputed at every change. **Every track must be content-independent** (px or
  fr): each row is its own grid container, so an `auto` track is measured per
  row and the columns stop lining up — the one thing the table is for.
- **Every elastic track carries a FLOOR, and `minmax(0,…)` is banned.** A zero
  minimum tells the browser it may take the column away entirely, and it does:
  measured in the lab, the agent name — the only thing that names a run — was
  6px wide at a 900px window and 0px at 840, while `docs` (60px) and `date`
  (132px) kept every pixel they had asked for. A test refuses a `minmax(0,…)`
  now.
- **The markup stays a real `<table>`, and every ARIA role is re-declared.**
  Overriding `display` on table elements DROPS their implicit roles in Chrome
  and Firefox; without `role="table"`/`"row"`/`"cell"` a grid-displayed table
  announces as a pile of divs.
- **The row is a LINK**, in the first column of tier one (a link parked in
  `#131`, which waits for a wider table, leaves the row unclickable on a
  phone), stretched over the row with `after:inset-0`. That
  overlay is also the trap: it paints over the other cells and takes the HOVER
  with the click, so a native `title` stops firing. Anything that answers to
  the pointer raises itself (`relative z-10`) — the titled ELEMENT, not its
  cell, so the dead zone is the size of the text.
- **THREE tiers, on the width of the TABLE, not of the window.** A column
  declares the room it needs (`tier: 2` waits for a 36rem table, `tier: 3` for
  56rem, unset is the row's identity and is always drawn), and the three
  templates ride as custom properties; dropping a cell without its track shifts
  every column after it. The threshold is a container query (`@container/table`)
  because the table sits beside a 256px sidebar: a `md:` WINDOW breakpoint let
  eight columns crush into 700px of table, and it was upside down — at a 768px
  window the table has 464px and shows three columns, at 720px (sidebar gone) it
  has 675px and shows five.
- **A tier is a promise, and the promise is arithmetic**: the sum of its floors,
  its gaps and its padding has to fit inside its own threshold. Nothing in the
  type system checks that, so `column-tiers.test.tsx` does, on the three real
  column sets. It is what forced `cron` out of the schedules tier one — name,
  state and a raw cron expression do not fit 390px together, and on a phone the
  name and the on/off are what a schedule is. That is a product decision a test
  surfaced, not one it took.
- Naming is not the table's business: `use-run-agent-name.ts` resolves what to
  call the agent a run executed and ALWAYS returns a name. Hiding the COLUMN
  must not blank the name — the row's accessible label is built from it.

Runs is the first column set (`dt-runs`): number, agent, status, trigger,
**result**, documents, duration, date. The result column is new — a failed
run's error was invisible on the very screen whose job is to say which one
broke.

Integrations and the main Documents destination joined the table family on 23
August. Documents has Name, Purpose, Type, Size, Created, Retention and Actions;
Integrations has Name, Origin, Version, Status and Actions. Both sets are in the
column-floor guard and keep identity plus Actions at tier one.

Still open on the table, deliberately:

- **Sortable heads.** The reference has them (`.th-sort`, `.th-sort.active svg`
  in `--accent`). `GET /api/runs` takes no sort parameter, so the head would
  either lie or sort one page of fifteen. It waits for the endpoint.
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
- **TWO treatments, and the SURFACE is what separates them**
  (`lib/toolbar-button.ts`, so every screen uses the same two). A control that
  adjusts the view — Filters, Columns, Import — is an outline on the canvas:
  solid grey border, no fill, no shadow. A control that acts on the data keeps
  a surface: white, slightly raised. Reading a bar left to right you can tell a
  setting from a deed without reading a word.
  No filled blue in the bar. "Nouvel agent" was the one, and it made the agents
  screen the only one whose action did not look like every other screen's.
  Note the trap in getting there: shadcn's `outline` variant paints
  `bg-background`, which is WHITE here (our page canvas is its own `--canvas`),
  so every one of them came out as a white pill on grey. Any port of a shadcn
  control onto the canvas has this to check.
- **The open filter row shows on the button that opened it**, through
  `aria-expanded:bg-accent` — the state is the style hook, so there is no
  second flag to keep in step.
- **The view toggle opens the row**, before the search and well before the
  actions. "What am I looking at" comes before "which rows" and before "what do
  I do", and it was sitting in the middle of the action cluster where it read
  as one more button rather than as a choice of representation. Its style is
  the shell's product tabs: a grey track, a white chip on the chosen one, no
  colour — the bar has none anywhere else, and a blue fill read as a state.
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
- **The state is in the URL**, pushed, not replaced — `lib/list-params.ts`
  since `/schedules` learned to filter, because those four functions were about
  to be written a second time word for word. A filtered list is what
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
- Integrations has its own localStorage key and defaults to the table. It is a
  separate collection preference, so switching the package family to cards
  does not silently move integrations with it.
- **The count is unconditional now, and it is under the body, not on the bar.**
  It used to render only while a search was running, on the reasoning that with
  nothing filtering it repeats what is on screen. That reasoning does not
  survive the family: `/runs` counted at every moment, the card grids counted
  only while searching, and `/schedules` never counted at all — three answers
  to one question, which is what step A exists to end. A footer is what the
  collection came to, whether or not anyone narrowed it.
- The count, when there is one, is passed as the CALLER'S OWN WORDS. A toolbar
  that formats "3 runs" for everyone is a toolbar that will one day say it
  about agents — it did, for about ten minutes.

## The integration detail

`pages/integration-columns.tsx` (the two column sets) +
`pages/integration-connection-cells.tsx` (the controls a connection row is made
of). The fourth and fifth column sets: the OAuth CLIENTS of an auth, and the
ACCOUNTS connected through it. Both were raw shadcn tables buried in an
1800-line page, and both were the last collections outside the family.

- **The provenance badge sits with the row's identity**, as on models,
  credentials and proxies — so the clients table lost its `Source` column and
  reads `Système  sys_a91f2c4d` on one line. Not for want of room this time
  (this table has a full page, not a 775px modal): for the four sibling tables
  to read the same way. Same reasoning took the two `col.actions` keys, which
  named a column the family draws headerless.
- **The share toggle is a checkbox, and the sentence is the header.** It used to
  repeat "Partager avec l'organisation" on every row, where it wrapped onto two
  lines and doubled the row's height. A column header says it once. A row the
  caller does not own keeps the checkbox, checked and disabled: the state is the
  fact, and the reason it cannot be changed is the "Partagée par Pierre" line
  already under the account's name.
- **A cell with state is a COMPONENT.** `cell` is called during the table's
  render, so a hook inside one is a hook inside a loop. The row component that
  used to hold the rename draft AND the delete confirmation is gone; each
  control owns its own state, in its own cell. That is also why the two files
  are split: `integration-columns.tsx` exports nothing but its two hooks, like
  `model-columns.tsx`, and the components live next door — a file that mixes the
  two trips `react-refresh/only-export-components` four times.
- **The auth block stopped being a card, and the page stopped padding itself.**
  A collection body wears the family's frame, so inside a card it wore two — and
  the card's 32px plus a stray `p-6` the page kept on top of the shell's own
  gutter left the table 266px at a 390 window where every other table gets 348.
  That overflowed a frame which is `overflow-hidden`, so it CLIPPED. Each auth
  now reads the way a list screen does: a header row with the connect action at
  its right end, and the collection under it, `space-y-8` apart — the space is
  what separates two auths once the border is gone.
- **Measured, not looked at — and then looked at.** That overflow is invisible
  on a screenshot at 1440; it was found with `getBoundingClientRect` across
  sixteen widths. After the fix nothing overflows at any width down to 390, and
  the account column never goes under 132px. The MEASUREMENT then missed one
  that only a look caught: inside the account cell, "Partagée par Pierre" was a
  `shrink-0` badge beside the name, so at 390 the badge kept every pixel and the
  account name — the only thing naming the row — rendered at zero width. The
  column was the right size; the cell ate it. It is a two-line cell now, name
  over provenance, like the models table's. **A floor protects a column from its
  neighbours, not a cell from its own contents.**

The lab had no fixture for this screen at all, so it could only ever be seen
failing. It has one now, and the three auths on it are what make the states
visible: an oauth2 auth with three accounts (one healthy, one needing
reconnection, one shared by ANOTHER member — so every owner-gated control is
exercised), a remote-MCP auth whose client is auto-provisioned, which is the
only way to reach the clients table's EMPTY state, and a `custom` auth with
nothing connected. On the auto-provisioned one the hint that explains the
emptiness IS the empty state's hint, rather than a second sentence saying the
same thing in other words above the table.

One fixture bug came out of it: `heavy` suffixed every id in the catalogue, so
the detail page found no summary for itself, said "Non activée", and the
scenario meant to load the table with volume never drew one. The first row
keeps its real id now.

## The list

`components/item-list.tsx`, the third body, extracted from the memory panel
where it already existed without a name.

**The order it was built in was wrong, and the product owner said so.** It was
planned last, behind the table and the grid, on the reasoning that it was the
least worked-out. The right reasoning is the opposite: of the three bodies it
is the only one that asks NOTHING of its container. The table wants width and
alignment across rows, and clips when it does not get them; the grid wants
20rem before it will take a second column. The list works in a panel, in a
modal, in a tab beside a sidebar, on a phone. **It is the universal fallback,
so it should have been the first thing built** and the other two the refinements
a screen opts into when its width and its content justify them.

What makes an item an item rather than a table row: the item is a
self-contained BLOCK that carries its own border and decides its own internal
layout, so nothing has to line up with the item above it. A table makes the
opposite bargain — alignment across rows, paid for in width.

It takes `CardGrid`'s contract verbatim and answers the states from
`collection.ts` in the same order. It is deliberately NOT `CardGrid` with one
column: the two are one line of CSS apart today, and merging them would mean
three props (a column floor, a gap, a skeleton shape) configuring a component
instead of a component being used, with call sites that no longer say which
shape they meant. If a third arrangement turns up, merge them then.

**What it fixed on arrival.** The memory panel had a single early return on the
counts — `pinned.length + memories.length === 0` — and no loading or failure
branch at all. Two queries that had failed both counted zero, so a 500 drew
"no memory yet": a collection claiming to be empty when nobody knew that. Both
tiers now answer failure, then loading, then emptiness, each in its own body.
The section headings lost their own empty sentence to the body, and their count
pills now render **only for an answer we have** — a pill reading "0" above a
body reading "this failed" is the same lie the run list's footer had to be
cured of, one level down.

The panel keeps its ringed empty state for the case where BOTH tiers are empty,
and each tier keeps a quiet italic line for its own emptiness. Two ringed
states stacked on one screen read as two failures rather than as one calm
answer.

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

`components/settings/setting-row.tsx` — `SettingsGroup` + `SettingRow`, with a
shape named for the control it holds. The rule it encodes:

> **The control IS the setting.** A field you type in, a dropdown you open, a
> toggle you flip — never a value with an Edit button beside it, which puts two
> clicks and a mode change between the user and a one-word change.

`InlineTextSetting` commits on blur or Enter, reverts on Escape. It is
uncontrolled and keyed on the incoming value, NOT mirrored into state: the
mirror needs an effect to follow the server, which the Rules-of-React gate
rejects (`react-hooks/set-state-in-effect`).

Converted so far: organisation name, workspace name and its OAuth redirect
domains, account display name, account email, workspace danger action, and the
dashboard-SSO toggle. Left: storage, MCP connect.

### THREE ROW SHAPES (decided 23 August, from the product owner's references)

The pattern was "label left, control right" for everything. It is three shapes
now, and which one a setting takes is decided by what the control IS:

1. **Field row** — label, then the description, then the CONTROL BELOW IT, at a
   readable width. Not 256px glued to the right edge. Order matters and it is
   label → description → control: you read a row top to bottom, and the
   description says what the setting is before you act on it. (The two
   references disagreed on this — one put the hint above the field, one below.
   One rule, and this is it.)
2. **Toggle row** — the checkbox and its label on ONE line, description
   underneath. This shape did not exist: the closest thing was the dashboard-SSO
   setting, a title plus a description plus an Enable/Disable BUTTON, which is a
   value with an action beside it — exactly what "the control IS the setting"
   rules out.
3. **Action row** — label and description left, button right. Unchanged. A
   destructive button stacked under its label costs twice the height to say the
   same thing, and "here is the setting, here is the deed" reads on one line.

### A FIELD'S SURFACE IS DECIDED BY WHAT IT SITS ON

Same rule as the toolbar's two button treatments, and for the same reason: the
SURFACE is what tells a control from its background.

- On the grey canvas (a list page) a field is **white**.
- Inside a white dialog (every settings surface) a field is **grey**.

One rule, two renderings. `packages/ui`'s `Input` now owns it: `bg-background`
by default, then `bg-muted` under a `DialogContent`, identified by that
component's `data-slot`. The toolbar's search box no longer carries its own
surface override, and settings fields no longer leave white rectangles on
white, readable only by their border.

### WHEN A CHANGE SAVES

Three cases, and the principle is whether a value can be VALID on its own:

- **One value → it commits alone**, on blur or Enter. A name is valid the moment
  it is non-empty.
- **Several values that are only valid TOGETHER → a modal that commits once.**
  An OAuth client with its id typed and its secret empty is not a state to send.
  The modal is where a complete value is assembled. This is what models,
  proxies, OAuth clients and webhooks already do; the rule names it.
  An Edit action is valid for one of these compound records; it is not a way to
  reveal a single field that should have been directly editable.
- **A list of independently valid values → each entry commits on its own.** The
  workspace's OAuth domains: a row commits when it is filled and left, and
  adding an empty row saves nothing, because an empty input is the residue of
  editing rather than a value.

### WHAT TELLS YOU IT SAVED

A toast on every rename is noise: it confirms something the reader just did and
can see. But the counter-argument has to be answered honestly — with a
commit-on-blur field, the box shows what you TYPED whether or not it saved, so a
visible value proves nothing. Hence:

| Moment                             | Signal                                                 |
| ---------------------------------- | ------------------------------------------------------ |
| While saving                       | the row shows it (a spinner beside the control)        |
| Failure                            | **always** a toast, and the field keeps what you typed |
| Success, effect visible in the row | nothing more; the spinner stopping is it               |
| Success, effect NOT visible        | a toast, because nothing on screen would say it        |

The email change is the last case exactly: the field still shows the old
address, and the real effect is a verification message sent elsewhere.

**And the email is directly editable, not a dialog.** A modal was built for it
on 22 August on the grounds that a stray blur would send a verification link to
a typo'd stranger. That was over-cautious and was reverted on 23 August: the
verification link IS the confirmation, since the address does not become yours
until someone clicks it, so a confirm in front of a flow that confirms itself
is belt and braces. A Save button never protected against a valid-but-wrong
address either. The format guard means an invalid string never fires at all;
success gets a toast because the row keeps showing the current address while
verification happens elsewhere.

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
- **The canvas stays #FAFAFA.** Judged on 21 August against two deeper greys
  (#F6F6F6 and #F1F1F1) in the lab, on the real screens rather than on
  screenshots: the gap between the grey and the white of the cards and the
  actions reads well enough as it is. So the two toolbar treatments and the view
  toggle's track are settled with it, and none of the three is reopened without
  a reason that is not taste. 2% off white is quiet ON PURPOSE.
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
- **A settings list is a TABLE, not cards.** (23 August.) Members, workspaces,
  end-users, webhooks, API keys, CLI sessions: every row is a RECORD, the same
  fields in the same order, which is the table's bargain. Drawn as stacked cards
  each row reprinted its own labels — the CLI sessions card carried four of them
  per row where a head writes them once.
- **A table's action end is semantic, not ceremonial.** (23 August.) One
  frequent action on a compound record may stay direct; secondary and
  destructive actions go into shadcn's `…` menu. No editable whole means no
  pencil, and one deed means no empty overflow. Direct controls such as role,
  default and share remain in their own columns because the control is the
  setting.
- **Adding something is always the same gesture**: the white surface-treatment
  button with a `+` icon, opening a MODAL. Not a blue fill, not a bare label.
  The exception is by destination, not by taste: when "create" means opening a
  whole editor (an agent, a skill), it stays a link to a page, because that is
  the recorded excursion-vs-destination rule. The visual treatment is the same
  either way.
- **An editable value is edited in place, under its label**, never behind an
  Edit button and never pinned to the right edge of the screen. See "Form
  pattern" for the three row shapes this produced.

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
- **`@/…` resolves at typecheck but NOT under `bun test` from the root.** A
  type-only import through the alias is erased and never notices; the day
  something imports a VALUE through it, the whole suite fails on a module that
  typechecks fine. Relative paths for runtime imports in components, like every
  other lib import there.
- **A patch that does not match applies NOTHING, silently.** Prettier reformats
  on every write, so a string copied from an earlier read stops matching, and a
  scripted edit reports success having changed nothing. It cost three passes of
  doc updates that were never written. Re-read the target, or assert the match.
- **The MCP browser belongs to whoever opened it.** Killing `chrome-profile-beta`
  to clear a stale lock closes the browser of another live session. Ask before,
  or work without it.
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
  creep. It also found a failing test nobody had run. On the integration tables
  it was right four times out of six: it caught an `ErrorState` drawn without
  its reason, a `disabled` lost in a move, and two comments claiming more than
  the code did; it was wrong about a width that a measurement contradicts, and
  proposed a shared component that would have undone the truncation fix.
- **It reads the DOC as the spec, so every rule written here becomes something
  the review can check.** That is a reason to write decisions down beyond
  remembering them: the last report is visibly better than the first ones, and
  the difference is that it had rules to cite.
- **It does not look at the screen** — not from inability (its sub-agents run
  `bun test`, `tsc` and `eslint` quite happily) but because its brief is to
  read a diff in 400 words. The review and the DOM measurement cover two
  disjoint halves: everything found on the integration tables by the review was
  textual or structural, and both visual defects came from measuring and
  looking. Do not try to merge them.

## The grammar — component types, not pages

**Decided 21 August 2026, and it re-frames everything below it.** The work
stops being "redesign the runs page, then the schedules page". It becomes:
name the KINDS of surface this application has to know how to draw, give each
one a component, then sweep every place that should be using it. Pages become
assemblies of a small vocabulary rather than sixty individual designs.

The trigger was noticing that the settings modal and the "integrations
Appstrate offers" catalogue want the same thing: a collection, inside a modal.
Nothing in a page-shaped plan makes that visible.

### What is there today, counted

Re-run this rather than trusting the numbers below, which will age:

```bash
cd apps/web/src
grep -rln "grid-cols-" pages components modules | wc -l      # hand-rolled card grids
grep -rln "ui/components/table" pages components | wc -l     # raw shadcn tables
grep -rl "<Spinner" pages components modules | wc -l         # loose spinners
grep -rl "Skeleton" pages components modules | wc -l
ls components/ | grep -icE "modal|dialog|panel"              # bespoke modals
```

At the time of writing:

- **Collections.** 3 screens go through our `DataTable` (runs, schedules,
  packages). **4 used the raw shadcn `Table`**: library, models, proxies,
  integration detail — all four are done as of 22 August, and only the LIBRARY
  still draws a raw one, on purpose, because it is a matrix (below). Plus the
  compact lists (documents, connections, memory), each its own way.
- **Only THREE of those four are collections.** The library is a MATRIX —
  packages down, workspaces across, a checkbox at every crossing — and it stays
  on the raw table on purpose. `DataTable`'s contract is that a column is an
  attribute of the row and may therefore be dropped when the width runs out;
  here a column is another entity, and dropping a workspace hides the only
  control that installs into it. The arithmetic says the same: three workspaces
  already come to 452px of floors against a phone's 390, with nothing that may
  be given up. **A matrix scrolls where a list degrades**, which is what
  shadcn's own `Table` does (`overflow-auto` on its wrapper) and what
  `DataTable` cannot (`overflow-hidden`, for the frame's radius). It takes the
  rest of the family instead: the same frame, the same head band, the same
  states drawn in place rather than above the tabs.
- **The card grid is drawn FOUR times, not sixteen** (re-counted 21 August).
  Sixteen files match `grid-cols-`, and that is the number this section used to
  carry, but most of them are LAYOUT: two-column forms, `[auto_1fr]` label and
  value pairs, a sidebar's `[8rem_minmax(0,1fr)]`. A grid that maps a list of
  entities onto cards happens in exactly THREE places — the integration
  catalogue (1/2/3 columns), the package list and the package detail's agents
  (both `grid-cols-1 gap-3 md:grid-cols-2`, character for character). The
  billing plans were counted as a fourth and are not one: `PlanGrid` is a
  COMPARATOR, three options side by side, and its column count is the number of
  options rather than a consequence of the room available. `auto-fill` would
  break it into 2 + 1 in the onboarding, which is ~700px wide. Same lesson as
  the fact grid, one line down: made of cards is not the same as being a
  collection. So the case for making it a component is NOT the
  duplication, which is two identical lines. It is that a collection has to be
  a thing before it can carry its own apparatus, or live inside a modal.
- **A second pattern hides in that miscount: the FACT grid.** `run-info-tab`,
  `manifest-fact` and the connections panel all draw label-and-value pairs,
  three different ways. It is not a collection (there is no entity, no row, no
  empty state) and it is not in the four families. Worth naming before someone
  files it under Collection because it is made of cards.
- **States.** `EmptyState` is shared across 31 files — the one thing already
  harmonised. Loading is the opposite: `LoadingState` in 35 files, **`Spinner`
  dropped in directly in 45**, and `Skeleton` in **3**. Three treatments
  coexist, and the best one — the table's skeleton rows, which hold the layout
  — is almost nowhere.
- **Modals. 21 files under `components/` define one.** There is `modal.tsx`,
  `panel-dialog.tsx`, `confirm-modal.tsx`, and eighteen bespoke ones. By far
  the largest duplication in the app.

### The four families

1. **Collection** — a table, a grid of cards, a compact LIST, and later the
   alternative views (an agenda). All three bodies exist as of 22 August:
   `data-table.tsx`, `card-grid.tsx`, `item-list.tsx`.

   It was called "the list-in-a-panel" here until 22 August, and the name was
   wrong in a way worth recording: NONE of the three is in a panel. Two are
   tabs on a detail page and one is a dropdown. `PanelDialog` exists and its
   only consumer is the settings surface. What the three share is not a
   container, it is a SHAPE — one row is a self-contained block rather than
   cells aligned into columns, which is the whole difference from the table.
   The component is named at extraction, not before: if reading the three shows
   they are two shapes and not one, the name has to say that, and forcing them
   into a component baptised in advance is the mistake the `grid-cols-`
   miscount already made once.

   **What makes the two bodies one family is `components/collection.ts`**, and
   it is the part worth keeping: a `CollectionState` (`isLoading`, `isError`,
   `empty`, `error`) plus the ORDER they are answered in — **failure, then
   loading, then emptiness**. A failed request outranks rows still in the
   cache, because drawing them tells someone data is current when nobody knows
   that; "we are fetching" beats "there is nothing"; and emptiness is last,
   being the only one of the three that is an ANSWER rather than a state of the
   request. The verdict is a WORD, not a node, so `isError` cannot be swallowed:
   a body that gets `"error"` must draw something, and owes a default when the
   caller wrote no message. Both mistakes were made on the way — the two bodies
   ordered the states differently for a day, and an `isError` with no `error`
   fell through to "there is nothing here" on a 500.

2. **The apparatus around a collection** — the bar (`ListToolbar`), the footer
   (`ListFooter`), the states. Done, except loading.
3. **Modal surfaces** — and this is where the families cross. There are almost
   certainly FOUR types hiding in those 21 files: confirm, form, **browse and
   pick**, and settings panel. The Appstrate integration catalogue is a browse
   and pick, exactly like the skills library: _a collection inside a modal_.
   Which is only possible once "collection" is a component.
4. **Row and card atoms** — status badge, origin badge, actor label, mono chip
   (cron, version), icon tile, unread count. They exist; they are applied
   unevenly.

### The order, and why

**A. Finish the Collection family.** _(22 August — mostly done. What is left is
named at the end of this bullet.)_ The card grid became a component, the raw
tables that are collections moved onto `DataTable`, and the compact list has
not been touched. It went first because family 3 depends on it: a
collection cannot live in a modal until a collection is a thing.

Done: `CardGrid` and the three grids that were one (package list, package
detail, integration catalogue); `collection.ts`, which is what makes the table
and the grid ONE family — the state a collection is in plus the order it is
answered in, failure then loading then emptiness; three of the four raw tables
(proxies, models, credentials); the library, which turned out to be a matrix
and keeps the raw table on purpose with the family's frame and states;
`/schedules`, which now has the same bar as `/runs`, filters in the URL
included (`lib/list-params.ts`).

**Left, in the order to take it:** _(1 and 2 are done; B is next.)_

1. ~~**The integration detail's two tables.**~~ Done 22 August — see "The
   integration detail" below. It is the last raw table that was a collection,
   so the Collection family now has one body for every list in the app bar the
   library matrix and the lists-in-a-panel.
2. **The compact list.** It was written here as "documents, connections,
   memory, three ways of doing one thing". **They are not one thing**, and
   seeing that is the whole of what this entry now says. Read and LOOKED AT on
   22 August, once the fixtures made the three reachable at all:

   - **Documents inside a run is a CARD GRID**, not a third body. It drew
     `repeat(auto-fill, minmax(10rem, 1fr))` by hand — the same technique
     `CardGrid` already owns, at a smaller floor. DONE 22 August: the floor is
     a prop and the run's gallery is on the family's grid. The main Documents
     destination is table-only as of 23 August; that later product decision
     does not change the compact, thumbnail-led run context.
   - **Memory is the third body.** Rows stacked, one row a self-contained
     BLOCK rather than cells aligned into columns, in two tiers (pinned slots
     over the archive) inside collapsible sections that carry their own count.
     It has **no loading and no error state at all**, so a failed request reads
     as "there is nothing here" — the exact lie `collection.ts` exists to stop,
     already fixed twice elsewhere on this branch.
   - **Connections is not a collection.** It is a form CONTROL: a dropdown that
     picks one connection out of a resolved cascade, whose items happen to be a
     list. It owes the family its STATES, not its body, and dragging it into a
     collection component would be the `grid-cols-` miscount all over again —
     made of rows is not the same as being a collection. DONE 22 August, and
     what it owed turned out to be one line: it had no failure branch at all,
     and `isPending` is false once a query has FAILED, so `!resolution`
     swallowed the failure into the loading branch and **the control span
     forever on a resolution that was never coming**. Failure first, then
     loading — the family's order, applied to a control instead of a body. It
     keeps its four other branches, which are business states (locked by an
     admin pin, blocked for this member, no OAuth client to connect through)
     and not states of a request.

   So the work is three smaller things, not one extraction: a floor prop on
   `CardGrid` and the documents grid onto it; the third body, out of the memory
   panel, which is the only real new component here; and the connection
   picker's five hand-written state branches answered by `collection.ts`
   wherever they mean what it means.

   **The third body landed the same day** (`components/item-list.tsx`) — see
   "The list" below — **and the documents grid with it**: `CardGrid` took a
   `min` prop (the column floor, 20rem by default, 10rem for thumbnails, the
   only thing that varied between the two grids) and the gallery moved onto it.
   That grid had been answering the states in the WRONG ORDER — loading before
   failure, so a 500 under a stale page drew a spinner rather than saying
   anything had broken. **A.2 is done**: the picker's failure branch landed the
   same day, and the three surfaces that were "three ways of doing one thing"
   turned out to be a grid, a list and a control, each now answering the states
   in the order `collection.ts` owns.

3. Then B, loading in one pass.

The browser pass handed A four inconsistencies to settle, all of them the same
shape — the apparatus is the TABLE's, not the collection's:

- ~~**The count is table-only.**~~ Fixed everywhere: the footer renders
  whatever the body holds, on the package screens in both views and on
  `/schedules`, which never counted at all.
- ~~**The bar vanishes when the list is empty.**~~ Fixed: the three early
  returns above the toolbar are gone, the states are drawn IN the body, and the
  empty state no longer re-offers the page's actions as unlabelled squares —
  the bar above carries them, written out. The `emptyExtraActions` prop that
  fed them was passed by nobody and is deleted.
- ~~**`/schedules` has no search and no filters.**~~ Both landed, and both are
  honest: `GET /api/schedules` returns the list whole, with no paging and no
  query parameters, so a client-side box searches every schedule rather than
  the page on screen — the test the package lists pass and the run list failed,
  which is why the run list waited for a `q`. The Actif / Désactivé state was
  the filter dimension it already had.
- ~~**The card grid is two columns at any width.**~~ Settled with the grid
  component: `repeat(auto-fill, minmax(min(20rem,100%),1fr))` takes as many
  columns as fit against the CONTAINER, so 1440 gives three and a narrow window
  gives one, with nothing declared. Still true on `unified-package-detail`,
  which has not moved yet.

**B. Loading, in one pass.** One rule — a skeleton for a collection, because we
know the shape of what is coming and the layout should not jump; a spinner for
an action in flight.

_(Started 22 August.)_ "Forty-five files, one line each" was wrong about the
shape of the work, and usefully so. The files that matter are not the 45 that
mention `<Spinner>` — most of those are buttons, which is a spinner doing
exactly its job. They are the **25 early returns of `<LoadingState />`**, and
what is wrong with them is not only the spinner: an early return takes the
whole screen, so the page's action button disappears while the list loads and
comes back when it arrives. The same defect the package lists were already
cured of, screen by screen.

Counted 22 August: `LoadingState` in 30 files, `<Spinner>` in 45, `Skeleton` in 5. The three bodies draw skeletons already, so a screen whose body is one of
them needs no new code — it needs its early return DELETED and `isLoading`
passed down.

Done so far, all nine the same way (early returns gone, `ItemList`, states in
the family's order, action button standing throughout): API keys, applications,
devices, webhooks, members, CLI sessions, webhook deliveries, OAuth clients,
and the personal connections page. Each was a `flex flex-col gap-3` or a
`space-y-2` around a `.map()` — the third body, written by hand, nine times.

Two things they taught:

- **Not every `<LoadingState />` is a request state.** The CLI sessions page
  guards on `!orgId`, and its query is DISABLED until there is one, so
  `isLoading` is false and a body would call the empty list an ANSWER. That
  guard keeps its spinner: it waits for context, which is what a spinner is
  for.
- **An item is a block, not an `<li>`.** The OAuth clients row rendered one,
  which was correct inside the `<ul>` it used to sit in and is a list item with
  no list around it inside `ItemList`.

**Left: 15 early returns**, and the count stops being the measure here. Every one of them is now either a DETAIL page — where
the shape of what is coming is a whole page rather than a list, and a
page-shaped skeleton drifts from the page it imitates — or a guard that is not
a request state at all (`!orgId`, a `Suspense` fallback for a lazy chunk, a
gate before a redirect decision). Both keep their spinner, which is the honest
answer when the shape is not known or when what you are waiting for is not
data.

So B is done for the collections: ten hand-written lists took `ItemList`, the
dashboard stopped replacing itself with a spinner, and every screen that draws
a collection now holds its layout while it loads and keeps its actions
standing. What remains would be a page-shaped skeleton per detail page, which
is a maintenance liability rather than a rule.

**C. Type the modals, then converge.** Read the twenty-one and establish that
there are four. Then the integration catalogue falls out on its own, as
"collection inside browse-and-pick".

**D. The atoms**, as A and C touch them, not as a block of their own.

The alternative views live INSIDE A, as a third view, once a collection is a
component that already holds two.

### Scope, for now

**No detail pages.** Overview, list, card and alternative-view surfaces only.
Run detail (`rd-*` + `ria-*` + `log-*` + `term-*`, about 130 classes and the
most-drawn screen in the reference) and the command palette (`cmdk-*`) are out
of scope until the grammar is in place.

### What the reference does and does not give us

**There is no calendar in the reference.** Zero occurrences — an agenda view is
ours to design, which our own rule allows when the reference is silent, but it
means nobody has drawn it for us.

**shadcn's `Calendar` is a date PICKER, not an agenda.** Verified against their
docs: thirty-odd variants (single, range, presets, with time, booked dates) and
not one of them renders content inside a day cell. That splits the calendar
question cleanly:

- **Runs want a date RANGE, not a month.** Forty runs a day would make a cell
  an illegible pile; the real question is "which week did this break", which is
  `start_date` / `end_date` — parameters `GET /api/runs` already accepts, and
  shadcn's range picker plugs straight in. Half a day, and it belongs in the
  filter bar.
- **Schedules want a real agenda**, and that is a build: cells holding items, a
  month/week switch, a "+3" when a day overflows. Either on top of the
  `Calendar` day grid or with a dependency (FullCalendar and its kind), which
  would be the app's first heavy UI dependency. Note that `packages/ui` has no
  `calendar` component and `react-day-picker` is not a dependency yet, so even
  the picker adds one.

**The agent icon is NOT a data-model gap**, unlike the org logo. The AFPS
manifest already carries `icon` (a string) and `icons[]` (`src`/`size`/`theme`)
— see `packages/core/src/validation.ts`. So agent identity is reading a field
that exists plus a derived fallback (a stable colour from the id and an
initial, like the org avatars). The reference places it at three sizes:
`ar-icon` 34px in a row, `ad-icon` 52px on an agent's page, `rd-agent-ico` 20px
in a run detail header.

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
5. **Order — SUPERSEDED by "The grammar" above.** What it says still holds for
   what is DONE: the table pattern (`dt-*`), the list bar (`lt-*`), the
   reference empty state (`empty-*`), and three column sets — runs, schedules,
   packages (agents + skills + MCP servers, behind the `view-toggle`). What
   comes next is no longer a list of pages but the A/B/C/D of the grammar
   section, and run detail and the command palette are out of scope until it is
   in place.
6. **Where the reference is silent, derive rather than invent**: grey canvas +
   white cards, the control IS the setting, excursion → modal / destination →
   page. Those four decide most cases on their own.
7. **When the reference contradicts what the screen shows, the screen wins** —
   it already happened once, with `:root` against the saved state.
8. **Merge in slices.** The branch is past fifty commits and the shell is
   independent of the screens. A shell-only PR can land before the first table exists;
   keeping everything for one big-bang merge makes the review worse and the
   revert coarser.

## Open

### NEXT, IN ORDER (written 23 August, for whoever picks this up cold)

Everything below this block is either done or older context. The open blocks
are what is next, smallest first, and each completed block is a commit with the
gate green (`bun test` + `bun run check`) and a look in the lab before it
lands.

**1. ~~The settings row pattern.~~ Done 23 August.** `SettingRow` has the three
shapes under "Form pattern", and the six existing rows use the one their
control calls for. Fields now take their own line, up to 512px on a wide panel
and the full 342px available on a phone; the workspace danger action stays
opposite its explanation. Account email is a directly editable field again,
with its format guard and a success toast because the verification happens
elsewhere. Dashboard SSO is a checkbox beside its label rather than an
Enable/Disable button.

`Input` owns the surface rule now: white by default, grey under a
`DialogContent`, whose `data-slot` makes the context explicit. The toolbar's
one-off white override is gone. Measured at 1440 and 390: field controls sit
12px below their copy, their rails resolve to 512px / 342px, neither the viewport nor the
dialog overflows, dialog fields render `--muted`, and the toolbar search stays
`--background`.

The fixture pass caught an omission before the SSO row could be judged: the
lab claimed its modules were on but did not set `features.oidc`, so the row was
hidden and the OAuth screen redirected away before its missing clients fixture
could announce itself. OIDC and dashboard SSO are on in the lab now, the OAuth
client list has a typed fixture, and the general-settings screen is in the
harness's coverage list. The workspace fixture also carries a real redirect
domain: the empty editor's Add button alone had hidden a 180px shrink-to-content
field that the row's outer 512px / 342px measurement could not catch.

The fixed-point review caught two behavioral gaps as well. Email now remounts
to the account's current address after a successful request (and after rejecting
an invalid format), while a server failure deliberately keeps the typed value.
Workspace and display-name failures now toast, and the domain controls lock
during their full-array write so two responses cannot race and restore an older
list.

A second review caught the last invisible variant: the lab selected the default
workspace, so its conditional danger row never rendered. The lab now starts on
the non-default Production workspace (while retaining a separate real default),
and its DOM exposes `field`, `field`, `action` at both widths.

That newly reachable OAuth screen also exposes older mobile debt outside this
row-pattern block: its client-card heading, badge and five icon actions compete
on one line at 390, forcing the client id into a narrow column. It is recorded
here rather than silently folded into an unrelated commit.

**2. ~~The add CTA.~~ Done 23 August.** Workspaces, API keys, end-users and
webhooks now use the same white `+` CTA as the rest of the product. Members no
longer reserves the top of its table for an email field, role select and Add
button: `+ Invite member` opens the standard modal, where the labelled email
and role controls assemble the complete invitation before one submit. Closing
the modal resets the form; a successful invite invalidates the organisation,
closes it, and an API failure stays visible inside it.

Measured at 1440 and 390, all five CTAs are 32px tall, contain exactly one SVG,
render `--background`, and produce no viewport overflow. The nested invite
modal measures 512px / 358px with 462px / 308px controls and no overflow in
either it or the settings dialog behind it. Its open, cancel, reset and reopen
path was exercised at 390 as well as inspected visually at both widths.

The fixture guard caught the API-key screen missing from the harness and, once
added, its unserved `GET /api/api-keys/available-scopes`. The screen is in the
coverage list now and the endpoint has a generated-OpenAPI-typed fixture; the
five-screen, two-width pass has no holes.

The block gate is green for `bun test apps/web` (559 pass) and `bun run check`
(33/33 tasks, the same nine pre-existing warnings). Root `bun test` reaches
10,625 passes, then reports 35 failures and 19 errors in the local MITM/sidecar
group. Running its reference listener file alone reproduces the documented CA
baseline exactly, 15/15 failures at `planCaBundle` because `caKeyPem` lacks the
expected PEM marker. No touched package is involved.

**3. ~~The row-action pattern and SSO table.~~ Done 23 August.**
`TableRowActions` owns one frequent direct action and the shadcn overflow
trigger, while callers keep the resource-specific items, permissions and
pending states. It deliberately does not make Edit or `…` universal: a direct
control stays the setting, a row with one deed gets no empty menu, and a record
with no editable whole gets no invented pencil. Secondary and destructive
deeds go in the menu, with the destructive group after a separator.

The SSO collaborator clients are a `DataTable` now. Client name, client id,
type, state and redirect URIs are separate desktop facts; the last column keeps
Edit direct and moves first-party status, enable/disable, secret rotation and
delete into the menu. Edit and Create push `?oauth-client=<id|new>`, while
closing replaces the URL, so Back closes a modal instead of reopening it.

Measured in the real settings containers, the table is 804px at a 1440 window
and 340px at a 390 window. It shows three columns / two columns respectively,
both row-action buttons are 28px, and neither viewport overflows. All four lab
scenarios pass at both widths. The fixture guard only found the modal's
previously unserved `GET /api/oauth/scopes`; it now has an OpenAPI-typed
fixture. The tests also caught the root runner's `@/…` resolution trap in the
new column set and the old card's orphaned `toggleFirstParty` locale key before
either landed.

The block gate is green for `bun test apps/web` (566 pass) and `bun run check`
(33/33 tasks, the same nine pre-existing warnings). Root `bun test` did not
reach a summary in this environment: after its pairing-cleanup hooks timed out,
it remained stuck in the systemd-unit setup spinner while the OAuth pairing
cleanup and webhook-delivery workers repeatedly reported `connect ETIMEDOUT`.
It was interrupted after several minutes; the touched web package is green.

The fixed-point review caught that the first action pass had inherited the old
card's feedback contract: visible badge changes still toasted on success,
failures said nothing, and pending disappeared with the closed menu. Success is
quiet now, every mutation failure toasts, and the row keeps a labelled spinner
beside locked actions while any deed is pending. It also replaced two repeated
confirmation-dialog bodies with the existing `ConfirmModal`.
A second pass put the pending label on the status element itself and widened the
action track from 72px to its measured 80px pending footprint; source markup
and the column-floor guard caught what the nominal screenshot could not show.

**4. ~~CLI sessions become a table.~~ Done 23 August.** Device, member, session
state, user agent, IP, connection date and last activity are separate desktop
facts. Device plus Actions stay at tier 1; Member, Session, User-Agent and Last
activity appear at tier 2, while IP and the connection date are tier 3. The
settings dialog never reaches tier 3, so its useful wide state is six columns
rather than a squeezed eight. The shared CLI icon now serves both this table
and the personal-device card instead of duplicating category logic.

CLI sessions have no editable whole, so the action end is `…` alone. Its one
Revoke item is destructive, disabled for the current session, opens the
existing confirmation dialog, shows pending on that row and toasts every
failure. There is no decorative pencil and no success toast for a row whose
disappearance is the success signal.

Measured inside the real settings dialog, the table is 804px at a 1440 window
and 340px at a 390 window. It shows four columns / two columns respectively,
and the full twelve-width sweep has zero overflow. All four lab scenarios pass
at both required widths with no missing fixture. The menu, its current-session
disabled state, the confirmation and its close path were exercised at 390;
the nested confirmation is 341px wide with no overflow.

The first geometry pass found zero overflow too, but its headers named Runs:
without `LAB_SELECTOR='[role="dialog"]'`, the harness had measured the first
table in the document, behind the settings overlay. Scoping the measurement
produced the CLI columns above. Looking at the screen caught a second wording
error the DOM arithmetic could not: the first header repeated the whole
"Active CLI sessions" title where the record field is simply "Device".

The block gate is green for `bun test apps/web` (570 pass) and `bun run check`
(33/33 tasks, the same nine pre-existing warnings).
Root `bun test` again advanced through the suite, then its pairing-cleanup hook
timed out at 10 seconds and the runner remained in the systemd-unit spinner
while that worker reported `connect ETIMEDOUT`; it was interrupted without a
summary after the same infrastructure failure reproduced.

**5. ~~Roll the action end through existing tables.~~ Done 23 August.** Models,
provider credentials and proxies now use the same action grammar as SSO. A
custom editable record keeps Edit direct and moves Test plus Delete into the
menu; a built-in or otherwise immutable record has the menu alone, with Test
inside it. It does not show a disabled or invented Edit control. An OAuth
credential that needs attention keeps Reconnect direct and puts Disconnect in
the menu, while a healthy OAuth credential has only the menu. The integration
OAuth-client table follows the same rule: Rotate or Update credentials is
direct on custom clients, Delete is secondary, and a system client invents
neither action nor overflow trigger because it has no available deed.

Test therefore lives in the same place on every model and proxy row instead of
turning into a flask-only direct action on system rows. Rotate/Reconnect uses
the refresh icon rather than a pencil, so the direct symbol describes its deed.
Pending connection tests remain visible in their own rows and lock both action
triggers. Mutation failures always toast; successful tests render their result
in the row, and successful deletions stay quiet because the row's disappearance
is already the confirmation.

The first Model cell no longer tries to be a miniature card. At desktop width,
Model, Provider, Type, Status, Default and Actions are six separate columns.
The technical identifier is deliberately absent from the list and remains in
the detail/edit surface. The phone keeps Model and Actions only; a transient
test result moves under the model name there so the hidden desktop Status
column never hides the feedback too. Set default is a deed in the overflow
menu, not an action disguised as the Default fact.

Measured in the real settings dialog, Models and Proxies resolve to 804px at
the stable desktop widths and 340px at a 390 window. Models shows all six
columns at 804px and resolves to Model 224px plus Actions 80px on the phone;
Proxies resolves to Name 224px plus Actions 80px there. The integration table
resolves to 1096px at 1440 and 348px at 390, with an 80px action track. All
three full sixteen-width sweeps have zero overflow. The nominal 1440 and 390
screens were also inspected, and all four scenarios across the three screens
pass at both required widths, 24 captures with no missing load fixture.

Exercising the menus found what the screenshot pass could not: Model, Proxy and
provider-credential Test each called an endpoint that the lab did not serve.
The three routes now share one OpenAPI-typed successful fixture. Their real
pending state was observed and each action settled to `OK (42ms)` without a
fixture hole.

The fixed-point review found six gaps before the commit. Concurrent tests used
one shared id, then the first correction still used per-call `mutate`
callbacks, which React Query detaches when a later call takes over the mutation
observer. The hook now tracks a set of ids and gives every row its own
`mutateAsync` promise lifecycle. A connection test can answer HTTP 200 with
`ok: false`, which now toasts just like a transport failure. Model, credential,
proxy and integration-client modal writes now toast their mutation errors too.
The inline credential rename also keeps the typed draft open, locks the field
with a row spinner while saving and toasts a failed write. The same shared
inline control now carries that contract for connection names as well.

Set-default writes were the other gap: they now show the spinner on the row
being changed, lock the other choices until it settles, always toast failure
and stay quiet on visible success. Finally, the lab gained a healthy OAuth
credential, so both the Reconnect-plus-menu and menu-only variants are visible
at 1440 and 390. The product-owner pass then caught the inconsistent flask-only
system rows and the overloaded Model cell; both are the uniform menu and
six-column desktop treatment described above.

The block gate is green for `bun test apps/web` (570 pass) and `bun run check`
(33/33 tasks, the same nine pre-existing warnings). Root `bun test` completed
with 10,636 passes, then the known local MITM/sidecar infrastructure group
reported 35 failures and 19 errors; no touched web test failed.

**6. ~~End-users become a table.~~ Done 23 August.** The local-state card click
is gone. Every row is a real link to `?user=<id>`: opening pushes, closing
replaces, Back closes the panel, and unrelated query keys plus the hash survive
both transformations. The direct Edit action uses the addressable
`?user=<id>&edit=1` form; changing between detail and edit replaces rather than
stacking another history entry. A direct deep link fetches its record through
`GET /api/end-users/{id}`, so it still opens when that user is outside the
currently loaded page. Every row and programmatic transition also carries the
settings route's `backgroundLocation`, so opening a user never swaps the
underlying screen for the cold-link dashboard fallback. The URL transformation
has its own regression test.

The cards became one `DataTable` with Name, Email, External ID, Created and
Actions. Edit is direct because an end-user is an editable compound record;
Delete is in the overflow menu, confirms, shows pending on its row and toasts a
failure. A successful deletion is quiet and immediately filters the row out of
both the current-page projection and the accumulated pagination pages, without
waiting for the invalidated query's refetch. A filtered miss has its own empty
answer instead of claiming the workspace has no users.

Name plus Actions are tier one. Email, External ID and Created enter together
at tier two; the date did not go to tier three, because this screen's settings
dialog tops out around 800px and would never draw it there. The set is
registered in `column-tiers.test.tsx`. In the real dialog it measures 804px at
a 1440 window: Name 185px, Email 185px, External ID 154px, Created 104px and
Actions 80px. At a 390 window it measures 340px: Name 224px and Actions 80px.
The full sixteen-width sweep has zero overflow.

The fixed-point review caught four gaps before the commit. Row and panel
navigations now preserve the settings overlay's `backgroundLocation`; a local
deletion tombstone covers the current query page as well as accumulated pages;
the direct-link fixture is a distinct off-page user and unknown IDs return 404;
and a pending edit or deletion can no longer close its modal and detach its
feedback. Edits now use an awaited mutation cycle and wait for cache
invalidation before leaving edit mode; deletions await the server response but
apply their tombstone before the background invalidation finishes. A mounted
guard still lets an error toast survive external navigation, but stops a late
success callback from undoing Back. Delayed, stateful PATCH and DELETE lab
handlers preserve resource identity and make pending, success and error paths
observable.

The list, detail URL and edit URL are now three permanent lab screens. All
three were inspected at 1440 and 390; all four scenarios produce 24 captures
with no missing fixture. Adding the direct-link screens caught one harness
mistake before the commit: the legacy `/end-users` redirect deliberately drops
its query string, so the first captures showed the list rather than the panel.
The lab entries now use the canonical `/workspace-settings/end-users` route,
which is also the URL the row links produce.

The block gate is green for `bun test apps/web` (580 pass) and `bun run check`
(33/33 tasks, the same nine pre-existing warnings). Root `bun test` completed
with 10,644 passes, then the known local MITM/sidecar infrastructure group plus
two saturated End-Users API cases reported 37 failures and 21 errors. The two
End-Users cases passed 9/9 immediately when rerun alone; no touched web or API
test remains failing.

**7. ~~Give every comparable table fact its own column.~~ Done 23 August.**
Stable facts are plain text in their own desktop columns. A badge is reserved
for a state that benefits from visual scanning, and that state owns its own
column. The phone keeps the essential identity and Actions only. A transient
test result may repeat under the identity on the phone so feedback is never
hidden with the desktop Status column.

Models now show Model, Provider, Type, Status, Default and Actions. Their
technical identifier left the list, and Set default moved into the overflow
menu. Proxies show Name, URL, Type, Status, Default and Actions; every row uses
the same Test and Set default menu grammar. Provider credentials show Provider,
Account, Type, Status and Actions. SSO clients show Name, Client ID, Type,
Status, Redirect URIs and Actions. Integration clients split Type out of the
client-id cell. Integration connections split Account, Status, Owner, Scopes,
Expires and Shared before Actions. CLI sessions use the field set recorded in
block 4. End-users were audited and already met the rule.

Three nearby tables had the same observable defect and were corrected without
expanding the feature: Members split email from the member name; Workspaces
split Default from the name; Webhooks split Agent and Payload. Member removal
and connection deletion also moved from isolated destructive icons into the
overflow menu. A connection that needs reconnection keeps that frequent deed
direct, while the Status column remains a fact and never becomes another
action column.

The tier guard covers every changed column set. In the settings dialog, Models,
Proxies, provider credentials, SSO clients and CLI sessions are 804px at the
1440 window and 340px at 390. Models and Proxies both resolve to 224px identity
plus 80px Actions on the phone; provider credentials resolve without overflow
to Provider plus Actions. The integration connection table measures 945px at
1280 and 348px at 390, where it resolves to Account 232px plus Actions 80px.
The full measured sweeps have zero horizontal overflow.

The first provider-credential split was mechanically complete but visually too
dense: Authentication repeated Type and truncated stable values. Browser
inspection reduced it to the mutually exclusive System, API key or OAuth Type
and gave Status the reconnection/availability state. The first integration
connection pass left Reconnect inside Status and a standalone trash icon at the
action end; the 390 screenshot caught the overlap that the desktop DOM measure
did not. Reconnect now lives at the action end, Delete lives in its menu, and
the narrow row is stable. This is another reason both geometry and pixels stay
mandatory.

The fixed-point Spec/Standards pass caught two final inconsistencies. The
Members role fallback was still a provenance-colored badge even though Role is
a stable fact; it is plain text now when the row is not editable. Widening Last
activity made the CLI screenshot legible but put the declared tier-two floors
8px over their 576px budget. Reducing the two flexible identity floors by 4px
each kept the full label, the real sweep at zero overflow and the tier guard at
56/56.

The block gate is green for `bun test apps/web` (584 pass) and `bun run check`
(33/33 tasks, the same nine pre-existing warnings). The ten changed screens
produce 20 nominal captures at 1440 and 390 with no missing fixture; the full
30-screen `bun run lab:shots` pass is green too. CLI's final sixteen-width sweep
has zero overflow after widening Last activity to its visible 120px footprint.

Root `bun test` could not exercise its infrastructure groups in this
environment: the preload immediately reported that the OrbStack Docker daemon
was unavailable, database setup then failed with `ECONNREFUSED`, and the suite
entered the known systemd-unit spinner. It was interrupted after the same
infrastructure failure reproduced across the DB-backed groups; the touched web
package remains green.

**8. ~~Harmonise the main Documents and Integrations collections.~~ Done 23
August.** Documents is table-only for now, by explicit product decision. Its
card view is deferred until that view can be judged on its own. The run-detail
Documents tab remains the compact thumbnail gallery it already was. The main
page now uses `ListToolbar`, `DataTable` and `ListFooter`, with one comparable
fact in each of Name, Purpose, Type, Size, Created and Retention. Actions keeps
the real server capabilities: Download is direct, while Open run, Keep and
Delete are secondary. Preview remains a real URL (`?preview=<id>`), and opening
it preserves the purpose filter plus unrelated URL state.

The purpose filter is in the URL. There is deliberately no search field:
`GET /api/documents` is paginated and has no `q`, so client-side search would
pretend to cover documents it had never loaded. The footer says how many rows
are loaded while `hasMore` is true, becomes the final count when the endpoint
is exhausted, and still renders an honest zero for a filtered miss. Storage
usage and keyset Load more remain.

Integrations no longer has the mixed `Activated / Installed` tabs. The main
collection is the organisation's administrable set: every custom integration,
including inactive custom records, plus activated system integrations. That is
the explicit `local || active` predicate, with a contract test so an inactive
custom object cannot become unreachable. The endpoint is drained page by page
before client-side search or filters are offered. Search is therefore honest;
Status and Origin are the two URL filters. Authentication is excluded because
one integration may declare several auth methods, so one summary-row value
would be ambiguous rather than a reliable filter.

The previous decision that Integrations should have no view switch is
superseded. It was correct for the old page only because that page mixed two
collections, the organisation's integrations and the system catalogue. Once
the catalogue moved to its own addressable `PanelDialog`, cards and table became
two views of one main collection, so the switch is coherent. It has a separate
local preference and defaults to the table. The catalogue itself stays cards,
with its own honest search and Status filter. They use distinct
`catalogue_q`/`catalogue_status` URL keys, so a shared catalogue URL reproduces
what its sender was looking at without colliding with the main collection.
Active state is one state badge, while origin and version are plain facts. Its
cards keep the real route to the detail and activation flow. Non-admins may
browse and consult; only admins see `+ Custom integration`.

Both list actions live at the right of the toolbar. `+ Custom integration`
keeps `/integrations/new`, and `Browse catalogue` pushes `?catalogue=1`; browser
Back reverses catalogue filters in order and then closes the panel. The close
control returns directly to the location from which the catalogue was opened,
so Back from the closed page cannot reopen it. A cold catalogue URL closes by
removing its catalogue-only keys. No install endpoint or authentication
taxonomy was invented.

The lab covers Documents, Integrations and the catalogue across nominal,
empty, heavy and error at 1440 and 390: 24 captures, no missing fixture. The
nominal and error surfaces were inspected visually. The empty scenario still
lands on the documented onboarding flow, so a zero-result integration URL was
also exercised directly. Opening the catalogue, browser Back, the card switch
and mobile viewport width were exercised in Playwright. Geometry sweeps report
zero overflow at every width. Documents measures 1096px with seven columns at
1440 and 348px with Name 232px plus Actions 80px at 390. Integrations measures
1096px with five columns at 1440 and 348px with Name 264px plus Actions 48px at 390.

The fixed-point review found three standards gaps. The all-pages integration
query now uses the typed-client `[method, path, init]` key shape, the catalogue
filters moved from component state into their distinct URL keys, and the
Origin/Status classifications used by filters, cards and columns come from one
pair of helpers. The Spec axis raised the root gate limitation below and
questioned the catalogue close implementation. The latter was checked against
the two simultaneous contracts instead of changed mechanically: pushed filters
make Back undo the latest filter first, while the close control traverses the
known catalogue history depth and does not leave an entry that can reopen it.
Both paths were exercised in the browser.

The touched web package is green for `TEST_TIER=0 bun test apps/web` (601 pass).
`bun run check` is green after providing the worktree's documented ignored
`.env`, with the same nine pre-existing warnings. Root `bun test` could not
reach a useful summary: Docker was unavailable in preload, database cleanup
then returned `ECONNREFUSED`, and the systemd-unit spinner kept timing out. It
was interrupted after the same infrastructure failure described by the prior
blocks; no touched web test remains failing.

**9. Accessibility, which nothing here has ever checked.** The branch
re-declares ARIA roles on the table because this file demands it, and that is
the whole of it: not one contrast ratio, keyboard path or touch target has ever
been measured. Meanwhile the last days added dozens of controls — icon buttons
at `size-7` (28px, against the 44px guidance) on tables now meant to work on a
phone, a checkbox column, disabled controls carrying state, and a row link
stretched with `after:inset-0`.

Do it in that order: one scoped sweep to find what is there, then turn what is
MEASURABLE into a guard — a one-shot audit ages at the next commit, a guard
catches the regression in six months. What is measurable:

- **Contrast** (4.5:1 text, 3:1 UI), read off RENDERED PIXELS. Converting oklch
  by hand was wrong twice already; see "The lab".
- **Touch targets** against 44px. Expect the icon buttons to fail; the answer is
  a decision (a bigger hit area without a bigger glyph), not a shrug.
- **Focus visible and tab order** on everything interactive, the stretched row
  link and the controls raised above it with `relative z-10` included.
- **`prefers-reduced-motion`**, which nothing respects today.
- **Labels and disabled state**: the share checkbox is `aria-label`ed, but a
  disabled checked box must still say WHY it cannot be changed, and today that
  reason is a sentence elsewhere in the row rather than anything tied to the
  control.

A third harness entry (`e2e/lab/a11y.mjs`, `bun run lab:a11y`) over the same
screens, exiting non-zero like the fixture guard, is the shape to aim for.

**Do NOT reach for the `tractr-design-review` skill here.** Evaluated against
this branch on 23 August: six of its seven passes are either already covered
(interaction states, design-system alignment, unresolved decisions) or off-topic
for a component-grammar refactor — its first pass BLOCKS on a product
positioning check, its third is JTBD discovery, its fourth hunts gradients and
glassmorphism in a project that derives from a fixed reference. It also scores
each dimension out of ten, which yields a number rather than a defect you can
contradict, and it has no browser, so it would audit rendering by reading
source, which is the half the two-axis code review already does. Its
responsive-and-accessibility pass is the part worth having, and it is what this
block is. The skill itself is left alone; it is simply not the tool for this.

After those, what is left in this section is: the Usage page (a feature to
build, not a defect), storage and MCP connect to the form pattern, the
page-action rule on screens without a list, per-org colour and logo (deferred by
decision, twice — do not start it), and library browsing through `PanelDialog`.

- ~~**The tier-one budget is the window, and it should be the container.**~~
  Closed 22 August, and it was worth the detour. The test asserted 390 (the
  window) where the real numbers are 348 on a page and 340 in the settings
  dialog, so three sets lived in the gap and the packages table clipped 28px of
  its last column at a 390px window, inside a frame that is `overflow-hidden`.
  The test now asserts the measured 340, the tighter of the two containers, so
  a set that passes is safe in both.

  The measurement then found something better than the bug it was sent for.
  **The worst container in the app was not a phone, it was a tablet**: at
  exactly `sm`, the settings dialog is `100vw - 4rem` = 576px and its 224px
  rail took 39% of that, leaving the table 304px — LESS than the 342px the same
  table gets at a 390px window, where the dialog goes full screen and the rail
  is gone. It clipped 72 pixels there, the widest overflow measured anywhere.
  The rail steps aside below `md` now, and that one class took the container
  from 304px to 524px. **Fix the container before crushing the columns**: three
  of the four sets would have had to give up a column for a defect that was
  never theirs.

  What the four sets did give up, once the container was honest: the packages
  table's `state` column waits for 36rem (it carries a badge only while a run
  is in flight and an em dash the rest of the time, which is not what 104px on
  a phone is for), and the three settings tables' action columns went from
  168px to 132px, with the test result truncating instead of taking room from
  the row's identity.

- ~~**Two rename affordances, one of them the Edit button the product owner
  ruled out.**~~ Closed 22 August. (This entry was dropped from the doc by
  accident earlier the same day, while the tier-budget bullet above it was
  being rewritten — a reminder that a scripted edit which replaces a RANGE
  takes whatever else was standing in it.) `InlineEditableLabel` is the app's
  one rename now: click the name, type, Enter or blur to save, Escape to
  cancel. The pencil that swapped the label for an input is gone from the
  connections table, which is what "Direct manipulation in forms. No Edit
  button revealing a field" says to do.

  The shared component grew the two things that had kept the second caller
  away, and both are worth knowing. It **truncates** — it sits in a table cell
  whose column has a floor, and a name that refuses to shrink eats the column,
  which is precisely how that table lost the name it was naming rows with a day
  earlier. And it can be **cleared** (`allowEmpty`), because a connection with
  no label falls back to its account id, so emptying the field is a real
  operation there; a credential has no such fallback, so clearing stays opt-in
  rather than becoming the rule. Its input also lost `min-w-40`, which in a
  132px column is an input wider than the cell holding it.

- **The browser pass is DONE (21 August).** Every list screen (`/runs`,
  `/schedules`, `/agents`, `/skills`, `/mcp-servers`) was walked on the four
  scenarios at 1440 / 1024 / 640, plus a width sweep measuring the real DOM at
  sixteen window widths. What it found, and what was done:

  - **The table crushed its columns between 768 and 1100px** — the one real
    defect, and a bad one: the agent name measured 6px at a 900px window and 0px
    at 840, with the INLINE badge painting over the status badge, while the
    fixed columns kept every pixel. Fixed by the tiers and the floors — see "The
    table". Verified by re-measuring: the name never goes under 112px at any
    width down to 390.
  - **The footer said "0 run" on a 500**, and while the first page was loading.
    `data?.total ?? 0` — the same lie the empty state had already been cured of,
    reappearing one component down. The count now renders only for an answer we
    have.
  - **The error state was a bare sentence in an empty card**, next to an empty
    state with rings and a badge: the state a screen shows when something IS
    wrong was the one nobody had designed. It reuses the empty state's treatment
    now, with a red glyph — without the colour the only difference between
    "nothing here" and "this failed" is the shape of a 24px icon.

  The three things the bullet asked about, and were found RIGHT: **the filter
  row** reads as a line you opened (the button takes `bg-accent`, the row is
  clearly its own line, it does not wrap at 640); **the bar's thresholds** work
  in the ordered way they were meant to (the utility labels go at a 576px bar,
  the action labels at 512px, nothing ever wraps) — with one reservation below;
  **the footer** renders correctly, count left, "Page 1 sur 14" and the arrows
  right.

  What that pass raised and how it closed:

  - **The two button treatments, and the view toggle's track** — both rest on
    the same 2% gap between the canvas and white, so both were put to the
    product owner on the lab's grey dial, at A / B / C, on the real screens.
    Answer: the gap reads well enough, the canvas stays #FAFAFA. Settled, and
    now recorded under "Judgments the product owner has already made". The dial
    was deleted with the decision.
  - **Two findings of that pass were WRONG, and both from reading the wrong
    number.** Worth keeping, because the same mistake is one measurement away:
    - "The search field is starved from 715px to 207px" — that was the width of
      the bar's LEFT SLOT, not of the field. The field is capped at 250px
      (`max-w-[250px]`) and does not move at all between 1440 and 960. It dips
      under the cap in exactly two windows (207px around 900, 237px around 660)
      and comes back up as soon as the next threshold frees room. Nothing to
      arbitrate: moving the thresholds earlier does not widen a capped field, it
      only widens the gap in the middle of the bar.
    - "No scenario shows an empty list" — this said `/skills` and `/mcp-servers`
      "are empty in all four", and **that was wrong, which the fixture guard
      proved on its first run (22 August)**: neither endpoint had a lab handler
      at all, so both 404'd and both screens were drawing a FAILED REQUEST that
      a previous pass read as an empty list. They have fixtures now, and rows.
      The observation underneath survives: an empty TABLE is still unreachable
      (`/runs` and `/schedules` never are), so the trio of empty state + count +
      pagination has never been seen together. It belongs to A.

      Worth keeping for what it says about method. "Nothing here" and "the
      request died" look alike from across the room, which is why a screen with
      no fixture does not merely go unlooked-at: it gets looked at and
      MISREAD, and the misreading is then written down as fact.

- **The API gained three things** for the toolbar, all tested: `GET /api/runs`
  takes several statuses at once (`?status=failed,timeout` → `IN (…)`), a free
  text `?q=` (agent scope and name, the error, and the run number when the query
  is digits — substring, no index, `pg_trgm` the day a workspace holds hundreds
  of thousands of runs), and `?user=me` composes with every other filter
  instead of taking a separate path.
- **`?user=me` combines now** (`listGlobalRuns({ mine })`). It used to take a
  separate query that dropped `kind`, `status` and the date range on the floor,
  so the screen showed two filters as active and the server applied one — the
  toolbar could not have been drawn honestly on top of it. One behaviour change
  came with it: an END-USER passing `chat_session_id` now gets nothing rather
  than their own runs, because chat sessions belong to members and the filter
  is no longer ignored for them. That is the correct answer to the question
  asked, but it is a change.
- ~~**Some page actions were still a filled blue.**~~ Fixed 22 August, and the
  gap was the SETTINGS surfaces: the two treatments were applied to the list
  screens when they were written and never to the settings ones, which was
  invisible while those were stacked cards and glaring the moment they became
  tables. Six screens took the surface treatment (API keys, workspaces,
  members, end-users, webhooks, OAuth clients), and their empty states stopped
  REPEATING the action — the button above stays now that the early returns are
  gone, so the empty state offering it again was the duplication the run list
  had already been cured of.

  Two rules held up under it, and both are worth keeping:

  - **A form's submit is not an exception.** The members invite is a form, but
    it performs the same deed as every other screen's "new …" button, so it
    takes the same treatment. The rule is about the DEED, not the markup.
  - **A dialog's confirm keeps its surface.** The bar rule is about a bar. In a
    modal, the button the modal was opened for is the primary and stays one.

  Swept and verified: seventeen screens, zero `bg-primary` buttons left
  anywhere in the app.

- ~~**Preferences was the last screen on the old form pattern.**~~ The display
  name is an `InlineTextSetting` now. The email is the pattern's documented
  EXCEPTION and earns it: changing it sends a verification message to the
  address typed, and a blur on a typo would send it to a stranger — so its
  control is a button that opens a dialog, which is what the row pattern says a
  consequential change looks like. Storage and MCP connect are what is left.
- **Usage page**, scoped by user: observability, not billing — who spends what,
  on which agent, with which model, for the agents a user can reach.
  `/api/runs` already accepts `start_date` / `end_date` / `user=me`, and each
  run carries `cost`, `token_usage`, `model_label`, `user_name`, `agent_name`,
  so a v1 aggregates client-side. That does NOT scale past a few thousand runs;
  a server-side aggregate endpoint comes after the shape is agreed.
- **Remaining settings screens** to the form pattern. The **workspace** screen
  is done (22 August), and it was the one the entry named twice: its name field
  is an `InlineTextSetting`, its OAuth redirect domains commit on blur and on
  removal, and its danger zone is a `SettingRow` with a destructive control
  rather than a red-bordered card that read as a different kind of screen. **The
  Save button is gone**, which was the last one in the settings surfaces — it
  made the workspace the one screen where a change was not a change until you
  pressed something else.

  One rule came out of the multi-value field: **adding a row does not save**. An
  empty input is the residue of editing, not a value, so it commits when it is
  filled and left, and empty rows are dropped on the way out.

  Left: storage and MCP connect.

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
- **Library browsing** (skills and templates) reuses `PanelDialog`.
  Integrations uses it already, as recorded in Open block 7.
- **The page-action rule is applied to LIST screens only.** On a screen with a
  list, the action sits at the right end of the bar; a screen without one keeps
  it at title height in `PageHeader`. Olivier's ask is that it be the same place
  either way — top-right of the body, whether the page holds a table or free
  content. Getting there means the bar (or something bar-shaped) on every screen
  that has an action, which is a sweep of the detail and settings pages, done on
  purpose rather than in passing.
- ~~**Integrations is the one list still card-only.**~~ Superseded by the 23
  August product decision recorded in Open block 7. The 22 August decision
  correctly separated the organisation collection from the catalogue, but its
  conclusion, no switch, still assumed both had to remain beside one another on
  the page. The catalogue now lives in its own `PanelDialog`. The remaining
  main body is one collection, so its cards/table switch is honest. It uses a
  dedicated integration column set because Origin, Version and activation
  Status are integration facts, not the package family's running state.

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
