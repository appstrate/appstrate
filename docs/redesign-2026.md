# UX/UI redesign — decisions and state

Working branch: `feat/redesign-lab`. Reference stylesheet exported out of Claude
Design and kept outside the repo at `satellites/redesign-2026/styles.css`.

This file records the decisions whose REASON does not survive in the code. What
each commit did is in `git log`; what follows is why.

## How to run it

```bash
cd apps/web
bun run dev:lab   # fixtures only — no API, no database, no Docker
bun run dev:hmr   # hot reload against a local backend
bun run dev       # unchanged: build-and-watch, served by the API
```

`dev:lab` answers every backend call in the browser from `src/lab`. The
scenario switcher (bottom right) re-serves the same screens as nominal, empty,
heavy (200 rows) and error.

Two things about the lab that are easy to get wrong:

- The patch is on `window.fetch`, not on the typed client's middleware. The
  first screen has three independent callers — better-auth, openapi-fetch, and
  hand-rolled SSE/upload fetches — and only one goes through `api/client.ts`.
- It is injected by a serve-only Vite plugin as the module script _before_
  `/src/main.tsx`, because both HTTP clients capture `globalThis.fetch` when
  they are constructed at module-evaluation time. Anything `main.tsx` does is
  already too late.

Fixtures are typed as the response type the OpenAPI spec generates for the
endpoint that returns them, so a backend shape change fails `typecheck` on the
fixture instead of letting the lab drift. Writing them caught five `Run` fields
the lab was not filling.

## The target, read from the saved design state

`app.jsx` in the design project pins `layout: "droit"` and `fondsGris: true`,
and those two override everything the stylesheet declares at the top. The CSS
still contains the earlier "floating white card" variant; the JSX is what
decides. The target is therefore:

- grey (#FAFAFA) everywhere — canvas, sidebar, header — with white cards on top;
- content flush, no gutter card, no 16px top radius.

## Decisions

**`--background` stays white; the grey is its own `--canvas` token.** In shadcn,
`--background` is the COMPONENT surface: dialogs, sheets, toasts, outline
buttons, the active tab pill. The redesign keeps all of those white sitting on
the grey. Painting `--background` grey would have turned every dialog and every
active tab pill grey with it.

**Names do not map one-to-one between the design and shadcn.** The design's
`--accent` is the BRAND blue and lands on `--primary`; shadcn's `--accent` is
the subtle hover surface and takes the design's `--bg-alt`.

**Dark mode is derived, not ported.** The design's stylesheet has a `:root`
block and nothing else. Lightness structure is the one that was already here;
only the violet cast on the neutrals and the brand blue (lifted to L .68 for
contrast) changed. Revisit when the redesign takes a position.

**`--spark` (the logo coral) is chrome-only** — notification count, profile
avatar — never a primary action, which is what the blue means. Org avatars keep
`--sidebar-primary`: the design colours those per org, inline, so it takes no
position on a token for them.

**The org/workspace chip is deliberately NOT shaped like the trail segments
next to it.** A breadcrumb segment means "go up a level" — cheap, reversible.
The chip replaces the whole context. The coloured avatar and the up/down chevron
(never a right chevron) carry that difference.

**The workspace stays visible even with a single workspace.** A level nobody
ever sees is a level nobody learns. Its menu ends on a way to create one rather
than a dead end.

**"application" → "espace de travail" / "workspace", except where it means an
EXTERNAL OAuth application.** Eight strings keep the old word: "les applications
qui l'utilisent", "Applications clientes", the hosted-connect message an
end-user reads, and the provider-side OAuth app. Code identifiers and API fields
are untouched — this is vocabulary, not a data model change.

**The product switcher lives in the brand cell, not as a nine-dot grid in the
top-right corner.** Two reasons: you clicked right and the word on the far left
changed, and that corner holds personal things (notifications, profile) while
switching product is working context. The grid becomes the right answer again
past roughly five products; at two or three it promises a drawer and delivers a
list.

**Studio's glyph is `Blocks`, not a hammer or a wrench.** What the Studio does
is assemble (skill × connector × trigger), not repair — and the sidebar already
spends `Wrench` on Skills, `Boxes` on Intégrations, `Layers` on Agents.

**Nav groups are split by what you are DOING, not by object type.** Activité is
what is happening (schedules included — a schedule is upcoming activity);
Construire is what you assemble.

**Usage and Settings sit in a quieter meta block at the foot of the sidebar.**
Both are consulted occasionally and never in a working loop. The credits gauge
was removed entirely: a permanent progress bar spends attention every second on
a number read every few weeks, and it sat directly under the navigation.

**The four developer surfaces are one family.** API keys, OAuth clients,
End-Users and Webhooks are all org+workspace scoped; two of them were in the
main nav while two were already in settings. They now sit together.

**Documentation appears both in the product switcher and the profile menu.**
The duplication is deliberate: the profile menu is where people look for help
out of habit, and a second door costs less than a first door nobody finds.

## Traps hit more than once

- **`<button>` centres its flex content by default.** Rows with a subtitle sat
  left of rows without one; the brand cell drifted to the middle of the sidebar.
  Add `justify-start`.
- **A scroll container inside the content column desynchronises the header.**
  The header kept the full width while the content lost the scrollbar's 15px, so
  the profile sat 15px right of the content. The scroll belongs on
  `SidebarInset`, with the header sticky inside it.
- **Fields inside a popover inherit the base layer's input styling** (border,
  padding, focus ring) and have to undo it explicitly.

## Open

- **Grey depth.** #FAFAFA is 2% off white, faithful to the design but very
  quiet. One token if it should be deeper.
- **Per-org colour.** The design gives each org a colour; the data model has no
  such field. Deferred.
- **Usage page.** Observability, not billing: who spends what, on which agent,
  with which model, scoped to the agents a user can reach. `/api/runs` already
  accepts `start_date` / `end_date` / `user=me`, and each run carries `cost`,
  `token_usage`, `model_label`, `user_name`, `agent_name` — so a v1 aggregates
  client-side. That does NOT scale past a few thousand runs; a server-side
  aggregate endpoint comes after the shape is agreed, not before.
- **Settings become a routed modal** (background-location), two independently
  scrolling panes, full-screen on mobile. Splits in two: organisation settings
  and workspace settings, each opened by the gear the design already draws on
  its switcher rows. That also removes `SettingsLayout`'s sidebar-collapse
  side-effect and the full-bleed misalignment it causes.
- **Excursion → modal, destination → page.** Settings and library browsing are
  excursions. Usage is a destination.
