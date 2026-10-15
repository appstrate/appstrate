# Design system (`apps/web` + `packages/ui`)

The visual grammar of the dashboard: which component answers which need, and the
rules every screen follows. Read it **before** building or changing a screen, a
dialog or a setting. When you need something it does not cover, build it from
the closest pattern here, then add one line for it below: a pattern that lives
only in code is a pattern the next agent will reinvent.

This file is the catalogue. Paths below are relative to `apps/web/src/` unless
they start with `packages/` or `e2e/`.

## 1. Foundations

- **Primitives are shadcn**, in `packages/ui/src/components/` (`button`, `input`,
  `select`, `popover`, `command`, `dialog`, `sheet`, `tabs`, `toggle-group`,
  `switch`, `checkbox`, `radio-group`, `field`, `alert`, `badge`, `table`,
  `tooltip`, `dropdown-menu`, `collapsible`, `skeleton`, `sidebar`…). Native
  before custom: compose these, and read the shadcn source or block before
  drawing a filter, a table or a toolbar of your own.
- **Tokens** are CSS variables in `styles.css` (`@theme`). No hard-coded colour,
  radius or shadow: `bg-card`, `text-muted-foreground`, `border-border`,
  `text-destructive`, `text-success`, `text-warning`… Every screen works in light
  and dark.
- **Surfaces**: the page is `bg-canvas` (off-white), cards and dialogs are
  `bg-card` / `bg-background`. A field is white on the canvas and grey inside a
  dialog: `Input` does it by itself, never override its background.
- **Icons**: `lucide-react`, `size-4` in rows and buttons. A package's manifest
  `icon` follows one grammar for every type (`@appstrate/core/manifest-icon`):
  an Iconify id (`logos:slack-icon`; an agent's is `lucide:<name>`, drawn from
  the bundle) or an image URL. Always render it with `PackageIcon`
  (`components/package-icon.tsx`, sizes `sm` / `md`, skeleton while loading,
  placeholder on failure), never as an `<img src>`.
- **Numbers that change in place** (durations, costs, counts, timers) use
  `tabular-nums`.
- **Loading is in-page**: the frame (shell, `PageHeader`, toolbar, tabs, section
  titles) draws at once; only what waits on a read waits, in its place and in its
  shape, as `Skeleton` blocks (`components/loading-skeletons.tsx`):
  `DetailPageSkeleton` (with the crumbs the address already gives),
  `ListPageSkeleton`, `SettingsSkeleton`, `FormPageSkeleton`,
  `DashboardSkeleton`, `TextSkeleton` for a panel, a modal body or a section.
  Collections draw their own rows. Nothing is drawn from a default while its
  read is on its way: no `0`, no « Aucun… », no switch or field holding a value
  the server has not given (a click on it would write that default). A route waits on its chunk and its
  permissions under the skeleton its page draws (`skeletonOf`, `app.tsx`), so
  nothing jumps. `Spinner` (`@appstrate/ui/components/spinner`) is work in flight on a
  control (a button, a row being saved), never content on its way; no centred
  spinner, no « Chargement… » sentence. `BootScreen` is the one exception: before
  the shell exists there is no page to draw.

## 2. The shell

- **`ShellSidebar` and `ShellHeader`** (`components/shell-frame.tsx`) are the one
  frame of both products (Studio: `components/app-sidebar.tsx`, chat:
  `modules/chat/chat-shell.tsx`). A product passes only its own navigation;
  never copy the frame.
- The sidebar head is the organisation and workspace switcher
  (`components/org-switcher.tsx`: organisations left, the workspaces of the one
  being explored right; a pick always ends on a workspace). Products are tabs
  (`components/product-tabs.tsx`), the foot is the profile (`components/nav-user.tsx`).
  Navigation links are `SidebarNavLink`.
- **The sidebar's two groups are split by what you do, not by object type**
  (`components/nav-org.tsx`). Activité is what happened: Tableau de bord, Fichiers,
  Runs. Construire is what you configure and assemble: Agents, Skills, Intégrations,
  Planifications (last: a schedule is a trigger you set up, like an agent). The order
  is declared once there; the collapsed bar, the phone sheet and the active state
  all read it.
- The sidebar collapses completely (shadcn `offcanvas`, Cmd+B); the header then
  carries the burger and the hover peek. On a phone it is a `Sheet`. Navigation
  state is not duplicated: the header's trail is not drawn by the page, a
  `PageHeader` publishes its `breadcrumbs` to `stores/breadcrumb-store.ts` and
  `ShellBreadcrumb` draws them.
- Settings and the catalogue are **routed overlays**: `PanelDialog`
  (`components/panel-dialog.tsx`, a rail on the left, one scroll per pane) opened
  by a plain navigation to a path under `OVERLAY_PREFIXES` (`lib/route-access.ts`).
  `App` remembers the last page shown and keeps it rendered underneath (the
  dashboard when the app opened on the overlay); closing returns to it
  (`lib/modal-route.ts`). Nothing rides in the history state. Rail pieces:
  `RailHeader`, `RailGroup`, `RailLink`, `ContextSelector`
  (`components/settings/`). Settings are ONE shell (`pages/settings/layout.tsx`)
  whose rail lists three sections — Organisation, Espace de travail, Compte
  (`/preferences`) — built in `pages/settings/navigation.ts` from what each
  route lets the caller reach.
- A detail page that draws its title in the header (the agent, run, schedule and
  integration pages, and the skill and tool pages, through `DetailBar`,
  `components/detail-bar.tsx`) fills three slots the header
  exposes (`components/shell-header-slots.tsx`): the **lead** (identity tile,
  title, version pill, then the parent list and the id), the **actions** (left of
  the bell) and the **tabs** (`HeaderTabBar`, underlined, on the band's rule).
  The slots are portals: the page keeps its context, so the tab bar still answers
  the page's own `<DetailTabs>`, which therefore wraps the whole page, header
  included. The lead takes the breadcrumb's place; a detail page needs only its
  parent, the tab being already underlined. On a phone the lead is a row under
  the navigation row, and the organisation switcher yields (the sidebar still
  holds it).
- Outside that, the header's right end stays personal (notification bell, profile).
  A page's controls reach it only through a slot, never by drawing in it.

## 3. Page anatomy (detail pages)

Top to bottom, every detail page (agent, run, schedule, integration, skill):

0. **A detail page has no `PageHeader`**: its title, pills, actions and tabs are
   in the shell header (section 2). What the old header said under the title
   opens the overview tab: an agent's description, home space and origin
   (`AgentIdentity`), a package's description, a run's trigger, start, cost and
   duration (`RunHeaderSummary`). The package editor still uses `PageHeader`.
1. **`PageHeader`** (`components/page-header.tsx`): title with its identity tile
   in `icon` (`PackageIcon`), a one-line summary and the object's id as `children`, and in
   `actions` the status and version badges (`components/status-badge.tsx`, see
   section 8) then the **Actions** menu. `variant="collection"` is for level-one
   list pages only. One primary button at most (Lancer, Relancer, Annuler) next
   to Actions.
2. **The Actions menu** is one trigger at every width, labelled « Actions »,
   outline `sm` with a chevron (`TOOLBAR_ACTION` from `lib/toolbar-button.ts`).
   List, settings and detail pages use `PageActionsMenu`
   (`components/page-actions-menu.tsx`; `disabled` keeps the trigger in place
   behind a `DisabledReasonTooltip`, `contentClassName` widens the menu), settings
   pages place it with `SettingsPageActions`. The package menu
   (`PackageActionsDropdown`) and a schedule's are items inside it, never a
   hand-built trigger. A page with no deed has no trigger. Search, filters,
   columns and view changes are list controls, they never enter this menu.
3. **The band** between the header and the tabs, for a **present state that
   blocks and asks for an act** only: a model missing, an agent switched off
   here (`AgentInactiveAlert`), a schedule the platform disabled. An `Alert`
   (`packages/ui`; variants `destructive`, `warning`, `info`, `success`), its
   icon on the first line of text; a button inside it sits on that first line
   (`-my-1.5`). What _happened_ (a run's failure, an integration that lost its
   connection mid-run, files not saved) is never a band: it opens the run's
   overview as a `HealthCard` (`components/run-detail/run-warnings.tsx`).
4. **Tabs**: `HeaderTabBar` (`components/detail-tabs.tsx`, passed to `DetailBar`
   as `tabs`), underlined, an icon each, the tab kept in the URL hash
   (`useTabWithHash`, `hooks/use-tab-with-hash.ts`; it keeps the query string).
   When the list is wider than its container (a phone) it scrolls sideways and a
   fade marks each edge that hides tabs, nothing when they all fit. **The same
   tabs for every role** (a package's « Utilisé par » included): what a role may
   not do is said inside the tab (`RoleLimitNotice`), never by removing it. A tab
   a type of package has no use for is not offered to that type, whatever the role. The agent's tab ids are
   `AGENT_DETAIL_TABS` in `pages/unified-package-detail.tsx`.
5. **Vue d'ensemble**: a grid of `DetailSectionCard`
   (`components/detail-section-card.tsx`), each with an icon, a title and, when
   it summarises a settings section, a header arrow that opens it
   (`headerAction`). A problem the object carries opens the overview as a
   `HealthCard` (`components/health-card.tsx`; `tone` `blocking`, `warning` or
   neutral; rows are `HealthCardItem` with `HealthAction`s, badges
   `HealthIssueBadge`), with a link to where it is fixed or read. A cancelled run
   is a neutral one (« Run annulé »: who stopped it as the platform records it,
   and when), never a fact among the Exécution facts.
   **A run served by another model than the one chosen** is told after the launch, never as
   a band (the run starts anyway): a `warning` `HealthCard` « Modèle remplacé » on the run's
   overview (the chosen model, the one that served, a link to the agent's model setting),
   read off the `model_fallback` row of the journal the page already holds.
6. **Paramètres**: `AgentDetailSplit`
   (`components/agent-detail/agent-detail-split.tsx`) with a `SectionRail`
   (`components/settings/section-rail.tsx`, one `RailLink` per section, a lock
   when the role may not open it) and one section at a time under
   `SettingsHeading` (title + one-sentence description). The section is chosen by a search param
   (`?agentSettings=`, `?scheduleSettings=`; the default section leaves the
   param out) and the tab by `#settings`. Reference implementations:
   `components/agent-detail/agent-settings-view.tsx`,
   `components/schedule-settings.tsx`.

## 4. Settings: the control IS the setting

- One row per setting: `SettingRow` (`components/settings/setting-row.tsx`),
  `variant` `field` (label, description, control under it), `toggle` (switch
  beside the label) or `action` (button opposite its explanation). Groups:
  `SettingsGroup` (same file); headings: `SettingsHeading`
  (`components/settings/settings-heading.tsx`, `level` `page` or `group`).
- **No Edit button, no edit mode, no Save button.** A control saves itself: a
  select, switch or toggle on change; a text on blur or Enter, Escape reverts
  (`InlineTextSetting`, `components/settings/inline-text-setting.tsx`); typing or
  a slider after a 650 ms pause. A rename in a table is `InlineEditableLabel`
  (`components/inline-editable-label.tsx`), the one rename affordance, and it is
  **opened by the row's menu only**: a click on the name does nothing and no pencil
  appears on hover (both are noise next to the « … »). The row's « Edit » never
  renames, it edits what the name does not (a provider's key), in a modal with no
  name field; « Rename » is its own menu entry that puts the name in edit. A name
  outside a table (a page title) is renamed in its own settings, as a text
  setting (`InlineTextSetting`, « Général »), never in the header.
- **Several values valid only together** are assembled in a modal that commits
  once (model, proxy, OAuth client, webhook). **A list of independently valid
  values** commits each entry on its own.
- **One return of a write, everywhere** (agent, schedule, organisation,
  workspace, preferences, integration rules): `SaveFeedback`
  (`components/settings/save-feedback.tsx`: Enregistrement… / Enregistré / Erreur
  d'enregistrement). It sits with the control: in the `status` of its
  `SettingRow` (under a field, beside a switch), or at the foot of a section
  whose controls share one write. When one mutation writes several rows, each
  row reports only the write that carried its own key. A spinner or silence is
  not a return; a failure is also a toast, and the field keeps what was typed.
  The one exception is a write whose answer is not « saved » (an email change
  that sends a confirmation): its toast says so and the row shows only the
  pending line.
- Two writes are exceptions to the no-Save rule, each with one explicit button.
  A write the server cannot take in parts (a schedule's new actor that must name
  its connections in the same write): the extra fields appear under the control.
  The account's login email (`EmailChangeField`, `pages/preferences/general.tsx`):
  without SMTP it changes at once, so a half-typed address never commits on blur;
  the button waits for another valid address, and an invalid one is said under
  the field. A package's files and definition are drafts with an explicit save
  (`useUnsavedChanges`, section 12).
- **Under a field: a note on the left, a control on the right.** A note is text
  (where the value comes from, why it is locked, with its `Lock` icon); a
  control acts (Verrouiller). `InputFieldRow`
  (`components/settings/input-field-row.tsx`). A note is shown
  only when it adds something (the agent's value only when the schedule
  replaces it).
- A linked object (a schedule's agent) is shown as its preview card (identity
  tile, name, description, arrow), never as a bare link.
- **What does not apply to an object is not shown**, not shown disabled: one sentence says
  why, once, where the rows would have been (a personal workspace keeps its name and the line
  « toujours privé, vous seul pour membre »: no visibility, default role, redirect domains or
  deletion). A control that stays visible but dead is for a right the person lacks, with its
  reason (section 11), not for a setting the object cannot have.
- "Inherit" is always an explicit option and names what it inherits
  (« Hériter (Mistral Medium) »).
- **Choosing connections: one component, everywhere** (`ConnectionChoiceMenu`,
  `components/integration-connect/connection-choice-menu.tsx`). A trigger that reads the
  current choice like a select (« Hériter (12****oken) », the same form as the model and proxy
  « Hériter (Mistral Medium) », the name, « 2 connexions », « Aucune connexion »; never a « + »,
  which means add and belongs to the « Ajouter une connexion » entry), and a menu in **three
  exclusive modes, first-level radios** so that « Hériter » reads as an alternative to the
  choice below it, not a row of it: ( ) **Hériter** / « Utilise 12****oken, la connexion par
  défaut de l'espace » (the layer in the server's words, `run.connSource.*`), ( ) **Choisir des
  connexions** / « Cochez celles à utiliser », with the connections indented under it as
  **checkboxes** (one connection is still a box; capped at `MAX_CONNECTIONS_PER_INTEGRATION`;
  ticking one moves the mode to « Choisir »), ( ) **Aucune connexion** / « L'agent s'exécute
  sans cette intégration » (absent for a required integration); then « Ajouter une
  connexion » and « Gérer les connexions ». Each connection row is a name and one line of the
  same form (« Clé API · connectée depuis Default »), listed in the order the SERVER ranked them (`scope_fit`
  then least privilege: the client never sorts them again). What is ticked is what is CHOSEN, never a
  second tick for what the cascade would give. A mode a usage cannot answer is left out; with
  the list alone the menu shows the boxes without a radio. Where it serves, and how it writes:
  - the **agent's** and a **schedule's** Connexions (`PickerMenu`, fed by the readiness verdict):
    all three modes, « Valider » writes the ticked set, « Hériter » and « Aucune connexion »
    write at once, a lone connection writes when ticked (unticking it goes back to « Hériter »);
  - the **organisation default** of an integration page (`OrgDefaultSection`): the list alone
    (an empty set is « no default », which its own select says), each tick commits alone;
  - **pins** of an integration page (`NewPinForm`): « Choisir » and « Aucune connexion », no
    « Hériter » (a pin is the exception, its absence is the delete button), a form value;
  - the **identity of a schedule** (`ScheduleActorConnectionChoice`, in Identité, Connexions and
    the creation modal): after a 409 the candidates and « Aucune connexion » when optional, no
    « Hériter » (the server just said the actor's own resolution cannot decide); an optional
    integration nothing refused keeps « Hériter » (the absence of a pick) and « Aucune connexion ».
  - Usages over a plain list go through `ConnectionSetPicker` (same file, a controlled value:
    `null` no choice, `[]` none, each tick handed to `onChange`).

  What turns a trigger amber is `gatesRun` (`use-connection-picker.ts`): the server's `run_blocking`
  while nothing is chosen (an unset override included, which inherits the cascade), the pick itself
  once a set is chosen (an under-scoped, dead or unavailable member, or « Aucune connexion » for a
  required integration). An override reaching outside an admin lock says so under the locked
  picker (`override_outranked`). **A schedule takes no fallback**: the server refuses to arm one
  whose connections nobody named. When the caller arms a schedule that runs as themself and holds
  a single connection for an integration, the server names that connection on the write
  (`withScheduleFallback`); the SPA sends only the user's picks (`savedScheduleOverrides`) and
  shows the 409 `must_choose_connection` panel when the actor holds several; a launch that is refused is replayed
  without its own pick for the refused integrations, and « Relancer » waits for the live verdict
  of each of them (`retryDecision`).

## 5. Choosing a value

| Need                                                                 | Component                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A handful of options                                                 | `Select`                                                                                                                                                                                                                                                                                                                                                                                    |
| Many options, or options worth searching (time zones, people, icons) | combobox: `Popover` + `Command`: `TimezoneSelect`, `ActorSelect`, the icon picker in `agent-editor/agent-appearance-fields.tsx`                                                                                                                                                                                                                                                             |
| Several of a small set (weekdays)                                    | `ToggleGroup type="multiple"` (in `FrequencyComposer`)                                                                                                                                                                                                                                                                                                                                      |
| On / off                                                             | `Switch` (a `SettingRow` `toggle`)                                                                                                                                                                                                                                                                                                                                                          |
| Several of a long set (scopes, permissions)                          | `ScopeMultiSelect` (`components/scope-multi-select.tsx`, a searchable multi combobox grouped by resource, with a count and an all / none shortcut)                                                                                                                                                                                                                                          |
| A model (agent, schedule, run with options, chat)                    | `ModelSelect` (`components/model-select.tsx`, over `ModelPicker` of `packages/ui/src/components/model-picker.tsx`): the one list, in a Popover + Command, grouped by who pays (see below). Never a `Select` of models, never a flat list. The groups are `groupModelsForPicker` (`packages/ui/src/components/model-picker-groups.ts`), the chat's composer draws the same `ModelPickerList` |
| Which connections of one integration                                 | `ConnectionChoiceMenu` / `ConnectionSetPicker` (`integration-connect/connection-choice-menu.tsx`): the one component, section 4 lists where it serves. Never a bare list of checkboxes                                                                                                                                                                                                      |
| A time                                                               | `TimeField` (`components/time-field.tsx`): hour and minute selects, a period select only where the app's language counts in 12 hours. Never `Input type="time"`: the browser draws it in ITS locale, not the app's                                                                                                                                                                          |
| A schedule's rhythm                                                  | `FrequencyComposer` (`components/frequency-composer.tsx`; the cron model is `lib/cron-frequency.ts`), never raw presets                                                                                                                                                                                                                                                                     |
| A value to copy exactly (endpoint, redirect URI)                     | `CopyBlock` (`components/copy-block.tsx`); programmatic copies go through `useCopyToClipboard`                                                                                                                                                                                                                                                                                              |
| A secret shown once                                                  | `SecretRevealModal`                                                                                                                                                                                                                                                                                                                                                                         |

A `Select` never holds hundreds of entries.

**The model picker** shows only what the PERSON can use, grouped by who pays, in this
order: « <key> · Clé org » (the organization's keys, named after the key or, for someone who
cannot read it, its provider: « Mistral · Clé org »), « <credential> · Clé perso » or
« … · Abonnement perso » (the models their own credential serves), « Système » (the instance's
own models). The first row is « Hériter (<model>) » where the usage has an inheritance. The default
model wears a `Par défaut` badge; a search field appears from eight models. A model the person
cannot use stays in the list, greyed, with its reason underneath (« Clé org indisponible »,
« Désactivé », « Clé perso requise », « Clé perso à reconnecter », « Clés perso désactivées par
l'organisation »), and when the fix is theirs, one link under its group (« Ajouter votre clé
Anthropic → », to Préférences › Mes clés). In a schedule every model a personal key or
subscription serves is greyed with « Une planification ne peut pas encore utiliser une clé perso »
(the server refuses it: `model_scheduled`). The groups come from what `GET /api/models` already
says for the caller (`binding`, `billed_to`, `credentialId`, `needs_reconnection`) plus their own
credentials (`lib/model-picker.ts`); a new surface that picks a model uses this component.

## 6. Forms

- **A form in a modal**: `useAppForm` (`hooks/use-app-form.ts`, react-hook-form
  with « reward early, punish late » validation: `showError(field)`), fields
  through `FormField` (`components/form-field.tsx`) or the shadcn `Field` pieces
  from `packages/ui`. The form lives in a body component returning the
  `<form>`, the modal owns the chrome (tests cannot render portals).
- **A form built from a JSON Schema** (agent input, config, schedule inputs) is
  `SchemaForm` from `@appstrate/ui/schema-form`, imported through
  `LazySchemaForm` (`components/lazy-schema-form.tsx`) so RJSF and AJV stay out of
  the entry chunk. Labels come from `useSchemaFormLabels`, file fields from
  `useUploadClient`; an agent's input form is `components/agent-input-form.tsx`.
- Field error text is never `err.message` (section 10).

## 7. Collections

- A **collection** is three bodies that take the same props (`CollectionState`
  in `components/collection.ts`: `isLoading`, `isError`, `empty`, `error`) and
  answer them in the same order, failure then loading then emptiness:
  `DataTable` (aligned columns, needs width), `CardGrid` (`components/card-grid.tsx`,
  `auto-fill`, no breakpoints) and `ItemList` (`components/item-list.tsx`, stacked
  self-contained blocks, asks nothing of its container: use it in a panel, a modal
  or a narrow tab). A settings list is a table, not cards. A matrix (packages by
  workspace) is the one raw shadcn `Table`.
- `DataTable` (`components/data-table.tsx`) under a `ListToolbar`
  (`components/list-toolbar.tsx`: search, filters behind one button, column menu,
  view toggle; `ListFooter` for the count). Grid tracks are
  `minmax(<floor>px,1fr)`, never `minmax(0,…)`. A header that truncates at 1440
  px is a column too narrow, fix the width. Text a cell truncates carries its
  full value in `title` (a name, an email, a list); a column that holds a name
  has a floor that fits a usual one. `columnMode="scroll"` makes the
  reader's selected columns authoritative and scrolls them sideways instead of
  dropping tiers.
- **Two rules for every table** (both live in `DataTable`, no caller opts in):
  1. **A column that can be acted on never disappears.** A column declares what it
     is in its definition: a READ column (text, badge, date) may carry a `tier`
     and wait for room on a narrow screen (tier `2` for a 36rem table, `3` for a
     56rem one; `column-tiers.test.tsx` checks the arithmetic of every set); a CONTROL column (`control: true`: a
     select, a switch, a tick, a button, a link that does something) has no tier
     and is always drawn. The type forbids a `tier` on a control, and
     `components/test/column-tiers.test.tsx` fails on one in any real column
     set (add your set to it, and mark every column that holds a control). When a
     table does not fit, it scrolls sideways and holds its name column (the
     first read column, with the ticks before it) and its row's end (the
     headerless « … » column) in place (`sticky`), so a row is always named and
     its actions are always in reach. When the held columns would take more than
     half the table's width (a phone, a side panel), they let go and the whole
     table scrolls as one: a strip of a few pixels between them reads nothing.
     A scroll is better than a lost control, and
     a « … » menu is not the place for a dropdown: a control that is the setting
     (role, share, default) stays in its own column.
  2. **Columns resize.** Every column with a head has a handle on its right edge
     (cursor `col-resize`): drag it, double-click it to fit the column to its
     longest content (one click to see the full names), or focus it and use the
     arrows (Shift for a bigger step, Enter to fit). A column never goes below
     its track's floor. The width is kept per table (its `label`) in
     `localStorage`, like the hidden columns: no account identifier is written
     to storage (`stores/column-widths-store.ts`, a phone keeps its own), and the table
     works without it. The row's end and fixed-size ticks have no handle.
- **List state lives in the URL** (`lib/list-params.ts`: `useListParams` on a
  page, `useLocalListParams` in a panel that floats over a page): filters are
  pushed, the search is replaced, a reset is one update. Table or cards is a
  preference, not a location (`ViewToggle`, `stores/list-view-store.ts`, one
  store per family of list); hidden columns are in
  `stores/column-visibility-store.ts`.
- Toolbar buttons have two treatments (`lib/toolbar-button.ts`): `TOOLBAR_UTILITY`
  adjusts the view (filters, columns), `TOOLBAR_ACTION` acts on the data.
  `CollectionTabs` splits one collection into parts at the head of the bar; it is
  not a detail page's tabs.
- **Runs** (`components/runs-table.tsx`): the Résultat column is what ended the run
  (`runErrorText`), else one readable line of its structured output
  (`lib/run-output-summary.ts`: the first text, else « N champs », never JSON),
  truncated with a tooltip. Déclencheur names who or what launched it, and a dash
  when nothing is recorded: no column is left blank.
- **The keys tables** (Settings › Models, two tabs; Preferences › Mes clés). The rule that reads
  the whole page: **a connected key makes its provider's models available.** A row is a key or a
  provider, never a model. **Vocabulary, everywhere (`apps/web`, `packages/ui`,
  `packages/module-chat`, fr and en):** a **Fournisseur** (Provider) is the company that runs the
  model (Anthropic, Mistral, OpenAI); never « Service », and never a key. A **Clé** (Key) is a
  caller's connection to a provider: **Clé org** (org key, an API key or a subscription paired
  for the organization), **Clé perso** (personal key), **Abonnement perso** (personal
  subscription); « fournisseur » never names a key. Plus
  **Système** (the instance). Say « Mes clés », « Ajouter une clé org », « Autoriser des modèles
  avec une clé perso », never « Mes fournisseurs », « Ajouter un fournisseur », « identifiant ».
  Keep « fournisseur » where it means the company (« Ce fournisseur ne propose pas ce modèle »). The tabs are `CollectionTabs`, kept in the URL
  (`?tab=personal`, the first leaves it out), and both are read by a member with no write right
  (no Actions menu, no click on a row). Each tab places its own deed in the page's Actions menu.
  - **« Clés org »** (`components/providers-table.tsx`, columns in
    `components/provider-columns.tsx`, rows from `lib/model-providers.ts`): one row per
    organization key (an organization subscription included), then the instance's row, named « Système » (its Fournisseur says « Livrés avec
    l'instance »). Columns: Nom (no badge beside it), Fournisseur, Modèles (the models
    this key makes usable, a short list, the default one marked with a small star, « Aucun »
    otherwise), État, « … ». An organization key serves the models bound to it (`credentialId`);
    the instance row serves the built-in ones. A key the caller cannot read stays a row, named by
    its provider, with no menu. Menu: Renommer, Choisir les modèles, Changer la clé, Tester,
    Supprimer (a key no model uses: see « Delete a key » below); the
    instance, Choisir le modèle par défaut and Tester (a submenu of its models, aliases left out:
    a test would describe the backing they hide), for a caller with `models:write`. A click on
    the row (name included) chooses its models. Actions menu: « Ajouter une clé org ». Setting
    the default from the instance's row says so in a toast (« « X » est maintenant le modèle par
    défaut. »).
  - **« Clés perso »** (`components/personal-services-table.tsx`, columns in
    `components/personal-service-columns.tsx`): first the organization's
    `personal_model_credentials` switch (`components/settings/personal-credentials-setting.tsx`,
    the same write as in General), then one row per PROVIDER open to personal keys
    (`personalServiceRows`: a provider with a model left to personal keys, or one somebody
    connected a key for). Columns: Fournisseur, Modèles (the ones usable with a personal key of that
    provider, `binding: "user"`), Clés connectées (who plugged a personal key or subscription in,
    « Alice Martin (vous), Bob » or « Aucune », read off the credentials the server shows the
    caller), État, « … ». The providers listed are `personalModelServices`
    (`allowsMemberModels`: open to personal keys, `personal_allowed`, and with a listing that needs
    no key to ask with), subscriptions included (Codex, Claude Code). A click on the row, or
    « Choisir les modèles » in its menu, opens the provider's checklist
    (`?personalModels=<providerId>`). Actions menu: « Autoriser des modèles avec une clé perso »
    (the same checklist, with a choice of provider, titled « Modèles utilisables avec une clé
    perso »). Switched off, the table stays, greyed and inert, under « Les clés perso sont
    désactivées pour l'organisation ». Under it, for a caller with
    `model-provider-credentials:read`, **« Clés perso connectées »**: the first table over every
    personal key and subscription of the organization, with its type, and its holder's name under
    the name of another person's key. Its menu is the row's `allowed_actions` (an administrator
    gets Tester and Supprimer on a member's key; Renommer, Changer la clé and Reconnecter stay the
    holder's). It sits outside the greyed area: a key already held is deleted whatever the
    setting says. Each member still manages their own keys in Mes clés, linked under the tables.
  - **One State column** (`components/row-state-cell.tsx`, decided by `rowStates`), in both tables,
    in this order, and nothing when all is well: `Indisponible` (a key or subscription to
    reconnect, a key refused; for a provider, every key connected is), `Par défaut` (the row
    carries the organization's default model), `Désactivé` (it carries models and every one is
    switched off), `Aucune clé connectée` (a personal provider nobody connected a key for). No
    badge ever sits beside a name. It is a read column: below 36rem it waits for room like any other.
  - **Preferences › Mes clés** shows the first table narrowed to the caller's own
    personal keys and subscriptions, with a Type column (Clé perso or Abonnement perso); its action
    is « Ajouter une clé perso ou un abonnement ». The
    menu: Renommer, Changer la clé (or Reconnecter), Tester, Supprimer; another person's, Tester.
  - **Choose the models** (`?models=<credentialId>`, `components/model-choice-dialog.tsx`,
    state in `hooks/use-model-choice.ts`, the writes in `hooks/use-apply-model-choice.ts`, the plan
    in `lib/model-choice.ts`): **the list speaks of ACCESS, never of deleting a model.** A model exists at its provider; the
    organization gives or withdraws its access. Ticked is access, unticked is none, a star on the
    default. « Enregistrer » creates the ticked models that have no row yet, switches back on the
    ones that were switched off (`PATCH enabled: true`, their settings intact), switches OFF the
    unticked ones (`PATCH enabled: false`, never a `DELETE`; the footer says « Accès retiré pour N
    modèles »), then sets the default, in that order, so a default that moves can leave the one
    it replaces. A model switched off is listed UNTICKED, and the tables' Modèles column names only
    the models with access. **The default model's box is locked** (disabled, tooltip « Choisissez
    d'abord un autre modèle par défaut »: the server refuses `model_disabled`) until another model
    is starred. The words « Supprimer » and « Désactiver » do not appear for a model in this
    list: unticking withdraws access. A refusal the server names (`model_disabled`,
    `model_scheduled`, said by `refusalMessage`) is shown under the list or in the form. A saved
    model's finer settings (name, capabilities, prices, the key it is bound to) are the
    « Réglages avancés » link on its line: the model form, `?editModel=<id>`, which replaces the
    list, and opens only on a model a list offers (never one the instance ships). A model's own
    deeds sit at the start of that form's footer (`components/model-form/saved-model-actions.tsx`):
    « Supprimer » for a caller with `models:delete`, behind a `ConfirmModal` (« Supprimer le
    modèle ? »), and « Tester » for a model bound to an organization key (a model left to each
    member has none to test: `model_credential_required`), its result beside the button.
    « Ajouter une clé org » is the same list as its second step (provider and key first, every
    model ticked, nothing written until the last button, « Retour » keeps what was typed). The
    personal keys' models are the same list per provider (`?personalModels=<providerId>`), with
    the star and « Réglages avancés » like an organization key's.
    **A service that does not publish every id it serves** (an endpoint without `/models`, a live
    search; never a catalog, which binds only its own ids) ends its list with a line,
    « Ajouter un identifiant de modèle » (`components/model-form/manual-model-entry.tsx`, the
    model form's own `ManualModelFields`: id, name, « Définir moi-même les limites et capacités »).
    The id typed joins the list, ticked, and ships with the rest on the footer's button (the row is
    `manualRow`, `lib/model-form-payload.ts`): there is no second save. Detection
    (`useModelDiscovery`, its outcome said by `DiscoveryResult`) and the manual fields are the
    model form's own, shared with this list. A retry after a partly
    refused batch asks only for what failed: the dialog keeps the models its own submission created
    (`knownModels`, `lib/model-choice.ts`).
  - **Delete a key** (`components/delete-key-confirm.tsx`, its copy in
    `lib/key-deletion.ts`): the server refuses an organization key that model rows still
    reference (`credential_in_use`, `ON DELETE RESTRICT`), so the confirmation names every model
    using it, switched off ones included, and where they go (« La clé « Prod » est utilisée par
    2 modèles : A, B. Supprimez ces modèles ou liez-les à une autre clé (« Choisir les modèles »,
    puis « Réglages avancés ») avant de supprimer la clé. ») and offers only Annuler. Only a key
    no model uses is deleted. A member's personal key serves no model of its own: its
    confirmation says the member will have to add a new one.
- **Packages** (agents, skills, MCP servers, the organisation catalogue) are one
  list: `components/package-collection.tsx`, with `PackageCard` and
  `packages-table.tsx`. Do not build another.
- **A row has ONE way to act** (`TableRowActions`, `components/table-row-actions.tsx`):
  the « … » menu holds EVERY action of the row, and nothing else sits at the
  row's end. No pencil, download, reconnect or gear icon beside it, in any
  table. Order, always: edit or rename first, the resource's own deeds next,
  delete last behind a separator. A click on the row opens what its main deed
  did: its detail through `rowHref` (a row link is never replaced), else its
  edit modal through `rowAction` (`rowActionable` leaves the rows it does not
  apply to static: a built-in proxy, a space you are not a member of). **Rename**
  of a name that is an `InlineEditableLabel` is a menu entry (`btn.rename`) and the
  only way in: it puts the name in edit, focused and selected (`editing` /
  `onEditingChange`, both required, and `renaming` on `TableRowActions` so the menu
  does not take focus back). A click on the name does not edit it: out of edit the name is
  the row's text (raised above the row's cover so its `title` reads, and `DataTable` hands its click to the
  row, which opens as everywhere else), no pencil shows on
  hover, and every renamable name has its « Rename » entry in the same row's menu. A row with nothing to offer has no menu
  (no `menuLabel`), and a row whose only deed is the click (an integration that
  opens its page) has none either: no empty menu for one deed. A control that
  IS the setting (role select, switch, tick, share editor, default) stays in its
  own column; it is not an action of the row. `row-actions-one-way.test.ts`
  fails on a direct action beside the menu. A row is a link through the first
  cell (`rowHref`), a titled element inside it needs `relative z-10`. Whatever is raised and is not a
  control (a name, a held first column's wrapper) hands its click to the row (`handOver` in
  `data-table.tsx`: a plain click, on anything that is not a link, button, field or tab stop), so a click
  on a name opens the row like a click anywhere else. A menu deed that opens the page's own modal pre-filled
  on the row says so in the modal's URL value (`?view-as=space:viewer`, the
  roles page's « Prévisualiser »), the same modal as the page's Actions menu.
- States: a skeleton (section 1), `EmptyState`, `ErrorState error=…`, and
  for an unreadable resource `ResourceErrorState`
  (`components/page-states.tsx`). Never a silent redirect.
- **An empty collection you can add to always offers the add button**
  (`EmptyStateAction`, `components/page-states.tsx`, a white outline button with a
  `+`, as `children` of the `EmptyState`), and only to someone who may add: the same
  condition, label and handler (`useModalParam(...).open`, `creation.open`) as the entry
  in the page's Actions menu (`SettingsPageActions`, `PageActionsMenu`), written once and
  reused, never a second implementation. The Actions entry stays: the empty button
  repeats it, it does not replace it. The button repeats a MENU entry, which is
  hidden until opened; it never repeats a button that is already visible beside
  the list (the connections table's toolbar already carries « Ajouter une
  connexion », its empty state adds nothing, and a Preferences page whose
  « Ajouter une clé perso ou un abonnement » is a visible button does the same): two identical
  buttons on one screen read as a mistake. A person who may not add gets the sentence alone
  (it says who can, or says nothing about creating); the hint never promises a button
  that is not on screen. A filtered empty (« Aucun résultat ») offers « Tout effacer »,
  never the add button. Not concerned: collections nobody creates by hand (runs, the
  journal, memory, devices and CLI sessions, shares, tools of a catalogue, files) and
  an empty state that is a fault or a locked page.
- Adding something is one gesture: the surface (white) outline button with a `+`
  icon, or an item in the Actions menu, opening a modal; when « create » means a
  whole editor (agent, skill) it is a link to that page.

## 8. Cards, badges, atoms

- **Status badge**: `Badge` from `components/status-badge.tsx` maps a run status
  (success, failed, running, pending, timeout, cancelled) to the `packages/ui`
  `Badge` variant, icon and translated label; `compact` is a bare icon on a phone,
  `unread` adds the dot. Other statuses have their own small component, same
  `packages/ui` `Badge`: `ScheduleStatusBadge`, `ModelUnavailableBadge`,
  `HealthIssueBadge`. `MetaBadge` (same file) is the outline badge that says WHAT
  a row is (Inline, Supprimé), not how it ended. A version is a `secondary` badge
  with `font-mono`; an agent whose working copy differs from its last published
  version (or has none) wears « Brouillon » in its place, and only then; a
  disabled reason hangs on `DisabledReasonTooltip`.
- **Identity**: `PackageIcon` (`components/package-icon.tsx`), `OrganizationAvatar`, `EndUserAvatar`, `ActorLabel` (the
  member or end-user a schedule runs as). An end-user's initials sit in one of
  eight person colours hashed from their id (`--avatar-1..8` in `styles.css`),
  never a raw Tailwind colour.
- **Cards**: a summary block on a detail page is `DetailSectionCard`; a titled
  pane is `SectionCard` (`components/section-card.tsx`, a real `<h3>`); a figure with a label is `OperationalStat` (a `dl` row) with
  `OverviewCardAction` as its quiet footer action; a label and value fact grid is
  not a collection. Entity cards in lists: `PackageCard` (every package
  type, the dashboard's agents included), `ScheduleCard`, `RunCard`; a run as
  a dense list row is `RunRow` (the dashboard, the chat's context panel).
- Cards are `bg-card` with a `border` on the canvas; a clickable card is one
  stretched link (`absolute inset-0`), never a link around a button.

## 9. Dialogs and creation

- Always `<Modal>` (`components/modal.tsx`), never `Dialog` directly; the
  two-pane overlay is `PanelDialog`. A popover that needs the whole width on a
  phone becomes a bottom `Sheet` there (`notification-bell.tsx`).
- **A real modal has a URL; only the confirmations, the secrets shown once and
  the chat have none** (`useModalParam`, `hooks/use-modal-param.ts`). A
  creation, an edition, a detail, a setting, a choice of an element, a form, an
  explanation, a full-screen view, a pairing: all of them. It can be linked,
  reloads onto the same modal on the same object, Back closes it, the hash and
  the router state ride along. Opening pushes, closing replaces. Never
  `useState` for it, and no exception of convenience (« it is only a help
  text », « there are many of them on the page », « it is a display mode »): the
  value names what is open (a card's stable key, `<integrationId>:<tool>`), and
  never a position.
  - **Naming**: the param is named by the act and the object, in camelCase.
    `?newWebhook=1` creates, `?editModel=<id>` edits, `?endUser=<id>` shows, `?models=<credentialId>` chooses the models of a key. A
    value is `1` when there is no object, the object's id otherwise (a composite
    value when a page holds several of them: `?editOauthClient=<authKey>:<ref>`).
    A param read by several components of one page must differ per component.
    Export the name when several entry points open the same modal
    (`NEW_SCHEDULE_PARAM`, `NEW_API_KEY_PARAM`, `SHARE_PARAM`).
  - **An object that may not exist**: `useModalTarget(name, items)` resolves the
    id against the loaded list and drops the param for an unknown id, so a stale
    link never leaves a modal on nothing. Pass `undefined` while the list loads,
    never `[]`, or a deep link is dropped before it resolves. Never `find` the
    object by `param.value` by hand.
  - **One mechanism**: a modal's address is read and written by `useModalParam`
    only, never by hand from `location.search`: it alone closes by going back
    over the entry its opening pushed. A table row opens it with
    `rowAction={(row) => param.open(row.id)}`, not with a `rowHref` to its URL. Create and edit are two params
    (`newProxy`, `editProxy`) sharing one form component; the host closes only
    the one that is open.
  - **Handing over** to another modal (`share` to `moveHome`): one navigation,
    `open(value, closing)`, never two modals stacked.
  - **After a creation** that shows a secret once, the creation's param goes
    away as the secret appears (`ApiKeyCreateModal`, `WebhookCreateModal`,
    `OAuthClientFormModal`): the secret has no address and does not survive a
    reload.
  - **A pairing in progress** (`?connectProvider=<providerId>` in the
    onboarding) is a place too: its token lives in memory, so a reload reopens
    the modal and mints a new pairing instead of resuming the old one (which
    expires on its own). A link to the pairing of a provider that is already
    connected has nothing to pair: the modal closes. This is judged once, when it
    opens; a connection that arrives during the pairing is `onConnected`'s to finish.
  - **Without a URL, and only these**: (1) the confirmation of an act
    (`ConfirmModal`, the re-authentication that confirms one, the activation
    closure, the deletion of a chat thread): reopening « Supprimer X » from a
    link would be a trap; (2) what exists only in memory after an act: the
    single display of a secret (`SecretRevealModal`, the key
    just created), the connections a refused launch asks for
    (`RunLaunchRecovery`), the models step of a provider whose key was just
    typed (`ProviderAddFlow`): none of it is there after a reload; (3) the chat (`packages/module-chat`), whose message cards have no
    stable address; (4) what is not a modal, such as the notification bell, a
    popover that becomes a sheet on a phone. Each one is listed.
  - **The guard**: `components/test/modals-have-urls.test.ts` reads the sources
    and fails on a `Modal`, `PanelDialog`, `Sheet` or `…Dialog` whose `open`,
    `onClose` or guarding `cond &&` reads a `useState` of its file, directly or
    through a component-level `const` derived from it (`const closure =
closures[0]`), unless the pair is in its `EXCEPTIONS` list. Each entry names
    its case, one of the four above (`confirmation`, `secret`, `chat` — only in
    `packages/module-chat` — or `not-a-modal`), and one line of reason. The list
    also fails when an entry matches no code. A modal mounted only while its
    `useModalParam` is set has its address, whatever local condition narrows it.
    Port the modal to `useModalParam` first; add an exception only for the four
    cases above. The same test fails on a parameter name that is not camelCase.
- **Closing a form modal abandons its input**, whichever way (Annuler, a click outside,
  Escape, Back): the form is mounted only while its param is set (`{param.value !== null && <Form />}`,
  or the host returns `null`), so it reopens empty on a creation and on the stored values on an
  edition. Never keep a draft in a component that stays mounted while the modal is closed.
- Destructive acts: `ConfirmModal` (`components/confirm-modal.tsx`). Its title
  names the act (« Supprimer la planification ? »), its body says what changes,
  its button repeats the verb through `confirmLabel` (« Supprimer »), never
  « Confirmer ». It closes itself on a refusal; `keepOpenOnRefusal` when it shows
  the refusal inline. A delete hook never refetches the page being left (a 404
  GET): it invalidates the list, and the item's detail with `refetchType: "none"`.
- **Creating a small object** (schedule, model, webhook, key): a modal asking
  only what it needs to exist, opened by a URL param from every entry point
  with the context preselected, then the object's page takes the rest
  (`components/new-schedule-modal.tsx` is the example to follow). **Creating a package**
  (agent, skill, integration, MCP server): the creation hand-off modal
  (`components/creation-handoff-modal.tsx`, `hooks/use-creation-handoff.ts`:
  manual / chat / coding agent), then the editor page.

## 10. Feedback

- **Errors**: never `err.message` on screen. `errorMessage(err)` inline,
  `<ErrorState error>` in a panel, the global mutation toast for a failed
  write (no `onError` that toasts again, `lib/mutation-error.ts`). A refusal is
  worded by its `code` (`apiError.<code>` in `locales/{fr,en}/common.json`). A
  raw server payload (JSON, an English sentence) never reaches the screen: a 403
  `forbidden` carries only an English `detail`, so it is one sentence of ours
  (« Vous n'avez pas les droits nécessaires pour cette action. »).
- **What ended a run** is stored verbatim (an English platform line, a model
  provider's JSON body); a screen shows it through `runErrorText`
  (`lib/run-error.ts`), never `run.error` as is.
- **Toasts**: `sonner`, through the shared `Toaster` (`AppToaster`). A failure,
  or a result the screen does not show. No success toast where the row or the
  field already shows the change.
- An expected refusal that asks for a choice (a 409 naming candidates) is a
  form state with the choice, not « Erreur d'enregistrement » and not a fault: an
  `info` alert per integration, said by `ScheduleConnectionRefusals` wherever the
  write can be refused (Connexions and Identité of a schedule). It names whose
  connection and which integration by its display name, and says why the server
  cannot decide (« Choisissez la connexion Telegram pour e2e-C Membre » / « e2e-C
  Membre a plusieurs connexions Telegram. Une planification se lance seule : elle ne peut pas
  demander laquelle utiliser au moment de l'exécution. »); the choice is the
  `ConnectionChoiceMenu` under it. A refusal that is a fault (a connection the
  identity no longer reaches) is the one destructive list. Any other refusal puts
  the control back on the stored value and is toasted, with no inline error under
  it (`ActorSelect` in a schedule's identity).
- **Tooltips** explain an icon or a disabled control, never carry the only copy
  of information. They are shadcn `Tooltip`s under the one `TooltipProvider` at
  the app's root (`main.tsx`; `test/render.tsx` mounts it for the no-DOM tests),
  with one delay, 300 ms, set as the provider's default in `packages/ui`. A
  component never mounts its own provider; only the collapsed sidebar's labels
  are instant (`delayDuration={0}` on their own `Tooltip`). A disabled control gets its reason through
  `DisabledReasonTooltip`.

## 11. Roles and permissions

- Same navigation for every role; what a role may not do is said where the
  content would be: `RoleLimitNotice` (`components/role-limit-notice.tsx`) in a
  section, a rail item with a lock.
- The « view as » preview (`ViewAsBanner`) is on every shell and on a refusal
  with no shell around it (the chat), and the product tabs judge the persona on its
  grants alone (its own conversations do not count).
- « Prévisualiser » on a role's row opens the preview dialog already set to it
  (`lib/view-as-preset.ts`): a space role, in the current space with that role; the
  Member, in the current space when it is open, with the role that space gives its
  members (a Member reaches open spaces unasked); the Guest with no space (it
  reaches only what it is assigned). A chosen radio or select value reads as chosen
  (foreground colour): the global `button` and `label` base is muted, so a `Select`
  in a dialog sets `text-foreground` itself; only an unavailable option is greyed.
- An action the role cannot perform is **not offered**. When it must stay
  visible to explain itself, it is disabled with its reason
  (`DisabledReasonTooltip`, `components/disabled-reason-tooltip.tsx`). Never a
  button that ends in a 403 toast.
- A row's controls (a connection's rename and share, a model credential's edit,
  test, delete and reconnect) follow the row's `allowed_actions`, which the API
  computes for the caller; never re-derive them from permissions and ownership
  in the component.
- A choice lists only what the caller may pick (an actor who can run agents, a
  connection the actor can reach).
- Who reaches a route is declared once in `lib/route-access.ts` and enforced by
  `RouteGate`; read permissions with `usePermissions().can(...)`. A route the
  caller may not open says so (`NoAccessState`, in a small dialog when it
  is the catalogue, which has no pane to sit in); a route that does not exist here (module not
  loaded, team-space page in a personal space, an address that matches nothing)
  says so too (`UnavailableState`, `NotFoundPage`). Never a silent redirect. The « view as »
  preview (`components/view-as-banner.tsx`) cannot be dismissed.

## 12. Files, editors and content

- **A file shown anywhere** (run deliverable, preview modal, chat side panel)
  wears `FileArtifact` (`components/file-artifact.tsx`, on
  `packages/ui/src/components/artifact.tsx`) around `FileViewer`
  (`components/file-viewer.tsx`, by the server's `preview_kind`; its HTML sandbox
  is `allow-scripts` only, never loosen it). A file list is `DocumentListPanel`
  (table or `FileTile` grid), a preview is addressable as `?preview=<id>`.
- **A package's files** are one explorer in Paramètres › Explorer
  (`components/package-files/`: `FileTree` is a virtualised WAI-ARIA tree,
  `PackageFilesView` the editor). Edits stay in the package draft until the save
  bar sends them in one write; `useUnsavedChanges` blocks navigation while dirty.
- **An agent's input and output schemas** are edited one way: `SchemaFieldList`
  (`components/agent-editor/schema-field-list.tsx`, a table and a modal at
  `?field-input=` / `?field-output=`), in Paramètres › Schémas and on the creation
  page.
- **Code and JSON editors** are Monaco, only through the lazy facade
  `components/monaco/index.tsx` (`MonacoEditor`, `MonacoDiffEditor`; self-hosted,
  never import `monaco-editor` elsewhere). `JsonEditor` for a JSON value,
  `package-editor/content-editor.tsx` for typed text (it owns its text from mount,
  push new text by remounting with a `key`), `DraftDiffView` for a diff.
- **Read-only data**: `JsonView` (collapsible tree with copy), `Markdown`
  (`components/markdown.tsx`, lazy), `LogViewer` for a run's journal.

## 13. Chat

The chat is `@appstrate/module-chat` (UI in `packages/module-chat/src/ui/`, built
on assistant-ui) inside the shared shell (its list: `modules/chat/chat-sidebar.tsx`). It
uses `@appstrate/ui` primitives and the host's `t` (`chat.json`), it cannot
import from `apps/web`. A tool call is a `ToolCallCard` (`tool-uis.tsx`),
reasoning a collapsible group (`reasoning.tsx`), a run started from the chat a
`ChatRunProgressCard`, the model picker `model-select.tsx`, whose list is the shared `ModelPickerList` (section 5). The thread sits on the
canvas, surfaces on it are white cards, and heights hold across states (no jump).

## 14. Modules and feature gating

A surface served by an optional module reads its flag:
`useAppConfig().features.<flag>` (`chat`, `webhooks`, `oidc`,
`billing`, `mcp`). Without the module the entry leaves the
screen (a settings section, a nav item, a tab); it never opens on a 404. A route
that needs a module says so in `lib/route-access.ts` (`feature`).

## 15. Text

- French by default, English mirrored: every string through i18next
  (`locales/{fr,en}/*.json`, flat dotted keys), aria labels and placeholders
  included. No literal French or English in a component.
- `locales/test/locale-keys.test.ts` fails on a key missing in one language, a
  key no source references, and a key built at run time outside its allow-list of
  prefixes: use a map of literal keys.
- Plurals with `_one` / `_other` and `count`; never « fichier(s) ».
- French copy: no em dash and no double dash (comma, colon, parentheses);
  sentence case; « 1 problème », not « 1 problèmes ».
- « Espace de travail » (workspace) in the UI, never « application », except an
  external OAuth application.
- No development wording in the product (« à brancher », « dev », TODO).
- A permission is always named by its sentence (`lib/permission-labels.ts`:
  `permissionLabel`, `permissionResourceLabel`), in the matrix, in the pickers
  (`ScopeMultiSelect`) and in badges, never by its wire string (`agents:share`).

## 16. Motion

Duration and easing tokens live in `styles.css`: `duration-fast` (150 ms) for
every exit, tooltip and hover, `duration-base` (250 ms) for a surface opening,
`duration-slow` (400 ms) for a sheet, `ease-surface` for anything that moves. A
surface opens on `base` and closes on `fast`; an anchored one grows from its
trigger (`origin-(--radix-…-content-transform-origin)`). Reduced motion is
handled once in `@layer base`: do not add per-component handling, and a looping
movement uses `motion-reduce:animate-pulse`. No animation library.

## 17. Responsive

Every screen at 390 px: no horizontal page scroll, a grid has a single-column
variant (`max-md:grid-cols-1`, `lg:grid-cols-…`; a card grid is `CardGrid`),
header actions wrap (`PageHeader wrapActions`: the group of badges and buttons
wraps under the title as a whole), the sidebar becomes a sheet, a panel's rail
becomes a select (`PanelDialog mobileNav`). A surface that covers the page on a
phone (`PanelDialog mobileAsSurface`) sits at `z-30`, above the `z-10` / `z-20`
stretched links and action clusters of the cards under it. Tabs tighten to `px-2`
below `sm` (`DetailTabsTrigger`) so four of them fit 390 px.

## Checklist before handing UI work over

- [ ] Uses the pattern of this file for each need; a new pattern added here.
- [ ] Every role: same tabs, locked content explained, no 403 toast.
- [ ] Light, dark, 1440 px and 390 px; nominal, empty, heavy and error states.
- [ ] fr and en, no literal string, no raw server text.
- [ ] `bun test` and `bun run typecheck` in `apps/web`, `bun run check` from the root.
