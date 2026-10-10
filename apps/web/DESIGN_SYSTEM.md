# Design system (`apps/web` + `packages/ui`)

The visual grammar of the dashboard: which component answers which need, and the
rules every screen follows. Read it **before** building or changing a screen, a
dialog or a setting. When you need something it does not cover, build it from
the closest pattern here, then add one line for it below: a pattern that lives
only in code is a pattern the next agent will reinvent.

This file is the catalogue. Why each decision was taken lives in
`docs/redesign-2026.md` (the redesign's journal); never duplicate a rule there
and here. Paths below are relative to `apps/web/src/` unless they start with
`packages/` or `e2e/`.

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
- **Icons**: `lucide-react`, `size-4` in rows and buttons. An integration's logo
  is an image URL or an iconify id: always render it with `IntegrationIcon`
  (`components/integration-icon.tsx`, sizes `sm` / `md`, skeleton while loading,
  puzzle placeholder on failure), never as an `<img src>`.
- **Numbers that change in place** (durations, costs, counts, timers) use
  `tabular-nums`.
- **Spinner and loading**: `Spinner` (`components/spinner.tsx`) for work in
  flight on a control, `LoadingState` for a whole panel, `Skeleton` rows when the
  layout is known (collections do it by themselves).

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
- The sidebar collapses completely (shadcn `offcanvas`, Cmd+B); the header then
  carries the burger and the hover peek. On a phone it is a `Sheet`. Navigation
  state is not duplicated: the header's trail is not drawn by the page, a
  `PageHeader` publishes its `breadcrumbs` to `stores/breadcrumb-store.ts` and
  `ShellBreadcrumb` draws them.
- Settings and the catalogue are **routed overlays**: `PanelDialog`
  (`components/panel-dialog.tsx`, a rail on the left, one scroll per pane) opened
  by navigating with `openAsModal(location)` as router state (`lib/modal-route.ts`). A redirect inside them uses
  `NavigateKeepingState`, or the overlay turns into a full page. Rail pieces:
  `RailHeader`, `RailGroup`, `RailLink`, `ContextSelector`
  (`components/settings/`).
- The header's right end stays personal (notification bell, profile); page
  controls never move into it.

## 3. Page anatomy (detail pages)

Top to bottom, every detail page (agent, run, schedule, integration, skill):

1. **`PageHeader`** (`components/page-header.tsx`): title with its identity tile
   in `icon` (`AgentIdentityTile` for an agent, `IntegrationIcon` for an
   integration), a one-line summary and the object's id as `children`, and in
   `actions` the status and version badges (`components/status-badge.tsx`, see
   section 8) then the **Actions** menu. `variant="collection"` is for level-one
   list pages only. One primary button at most (Lancer, Relancer, Annuler) next
   to Actions.
2. **The Actions menu** is one trigger at every width, labelled « Actions »,
   outline `sm` with a chevron (`TOOLBAR_ACTION` from `lib/toolbar-button.ts`).
   List and settings pages use `PageActionsMenu`
   (`components/page-actions-menu.tsx`), settings pages place it with
   `SettingsPageActions`. A page with no deed has no trigger. Search, filters,
   columns and view changes are list controls, they never enter this menu.
3. **The band** between the header and the tabs, for a **present state that
   blocks and asks for an act** only: a model missing, an agent switched off
   here (`AgentInactiveAlert`), a schedule the platform disabled. An `Alert`
   (`packages/ui`; variants `destructive`, `warning`, `info`, `success`), its
   icon on the first line of text; a button inside it sits on that first line
   (`-my-1.5`). What _happened_ (a run's failure) is never a band.
4. **Tabs**: `DetailTabsList` / `DetailTabsTrigger`
   (`components/agent-detail/agent-local-tabs.tsx`), the tab kept in the URL hash
   (`useTabWithHash`, `hooks/use-tab-with-hash.ts`; it keeps the query string).
   **The same tabs for every role**: what a role may not do is said inside the
   tab (`RoleLimitNotice`), never by removing it. The agent's tab ids are in
   `lib/agent-detail-tabs.ts`.
5. **Vue d'ensemble**: a grid of `DetailSectionCard`
   (`components/detail-section-card.tsx`), each with an icon, a title and, when
   it summarises a settings section, a header arrow that opens it
   (`headerAction`). A problem the object carries opens the overview as a
   `HealthCard` (`components/health-card.tsx`; `tone` `blocking`, `warning` or
   neutral; rows are `HealthCardItem` with `HealthAction`s, badges
   `HealthIssueBadge`), with a link to where it is fixed or read.
6. **Paramètres**: `AgentDetailSplit`
   (`components/agent-detail/agent-detail-split.tsx`) with a rail of `RailLink`
   (`components/settings/rail-link.tsx`, a lock when the role may not open the
   section) and one section at a time under `AgentDetailSectionHeader` (title +
   one-sentence description). The section is chosen by a search param
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
  (`components/inline-editable-label.tsx`), the one rename affordance.
- **Several values valid only together** are assembled in a modal that commits
  once (model, proxy, OAuth client, webhook). **A list of independently valid
  values** commits each entry on its own.
- Show the outcome of a self-saving agent or schedule setting with
  `SaveFeedback` (Enregistrement… / Enregistré / error; in
  `components/package-detail/agent-configuration-tab.tsx`). A failure is always a
  toast too, and the field keeps what was typed.
- The one exception to the no-Save rule is a write the server cannot take in
  parts (a schedule's new actor that must name its connections in the same
  write): then the extra fields appear under the control with one explicit
  button. A package's files and definition are drafts with an explicit save
  (`useUnsavedChanges`, section 12).
- **Under a field: a note on the left, a control on the right.** A note is text
  (where the value comes from, why it is locked, with its `Lock` icon); a
  control acts (Verrouiller). `InputFieldRow`
  (`components/package-detail/agent-configuration-tab.tsx`). A note is shown
  only when it adds something (the agent's value only when the schedule
  replaces it).
- A linked object (a schedule's agent) is shown as its preview card (identity
  tile, name, description, arrow), never as a bare link.
- "Inherit" is always an explicit option and names what it inherits
  (« Hériter (Mistral Medium) »). A connection picker lists it in every mode, one
  connection included, as a radio checked while nothing is picked (« Résolution
  automatique » for a member's own pin); clicking the ticked row again does nothing.

## 5. Choosing a value

| Need                                                                 | Component                                                                                                                                          |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| A handful of options                                                 | `Select`                                                                                                                                           |
| Many options, or options worth searching (time zones, people, icons) | combobox: `Popover` + `Command`: `TimezoneSelect`, `ActorSelect`, the icon picker in `agent-editor/agent-appearance-fields.tsx`                    |
| Several of a small set (weekdays)                                    | `ToggleGroup type="multiple"` (in `FrequencyComposer`)                                                                                             |
| On / off                                                             | `Switch` (a `SettingRow` `toggle`)                                                                                                                 |
| Several of a long set (scopes, permissions)                          | `ScopeMultiSelect` (`components/scope-multi-select.tsx`, a searchable multi combobox grouped by resource, with a count and an all / none shortcut) |
| Several connections of one integration                               | `ConnectionSetChecklist` (`integration-detail/connection-set-checklist.tsx`, checkboxes capped at the integration's maximum)                       |
| A time                                                               | the native time field in `Input type="time"`, its clock icon hidden (shadcn's date-and-time block)                                                 |
| A schedule's rhythm                                                  | `FrequencyComposer` (`components/frequency-composer.tsx`; the cron model is `lib/cron-frequency.ts`), never raw presets                            |
| A value to copy exactly (endpoint, redirect URI)                     | `CopyBlock` (`components/copy-block.tsx`); programmatic copies go through `useCopyToClipboard`                                                     |
| A secret shown once                                                  | `RevealedSecret` / `SecretRevealModal`                                                                                                             |

A `Select` never holds hundreds of entries.

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
  view toggle; `ListFooter` for the count). Columns carry a tier: low tiers hide
  on narrow screens (`components/test/column-tiers.test.tsx` checks the
  arithmetic of every column set, add yours to it). Grid tracks are
  `minmax(<floor>px,1fr)`, never `minmax(0,…)`. A header that truncates at 1440
  px is a column too narrow, fix the width. `columnMode="scroll"` makes the
  reader's selected columns authoritative and scrolls them sideways instead of
  dropping tiers.
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
- **Packages** (agents, skills, MCP servers, the organisation catalogue) are one
  list: `components/package-collection.tsx`, with `PackageCard` and
  `packages-table.tsx`. Do not build another.
- **A row's end**: `TableRowActions` (`components/table-row-actions.tsx`), one
  frequent deed direct, the secondary and destructive ones in the « … » menu; no
  pencil on a row that has no editable whole, no empty menu for one deed. A
  control that is the setting (role, default, share) stays in its own column.
  A row is a link through the first cell (`rowHref`), a titled element inside it
  needs `relative z-10`. A menu deed that opens the page's own modal pre-filled
  on the row says so in the modal's URL value (`?view-as=space:viewer`, the
  roles page's « Prévisualiser »), the same modal as the page's Actions menu.
- States: `LoadingState`, `EmptyState` (says what to do and where the button
  is: never promise a button that is not on screen), `ErrorState error=…`, and
  for an unreadable resource `ResourceErrorState`
  (`components/page-states.tsx`). Never a silent redirect.
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
  with `font-mono`; a disabled reason hangs on `DisabledReasonTooltip`.
- **Identity**: `AgentIdentityTile` (`components/agent-identity.tsx`),
  `IntegrationIcon`, `OrganizationAvatar`, `EndUserAvatar`, `ActorLabel` (the
  member or end-user a schedule runs as).
- **Cards**: a summary block on a detail page is `DetailSectionCard`; a titled
  pane is `SectionCard` (`components/section-card.tsx`, a real `<h3>`); a figure with a label is `OperationalStat` (a `dl` row) with
  `OverviewCardAction` as its quiet footer action; a label and value fact grid is
  not a collection. Entity cards in lists: `PackageCard`, `ScheduleCard`,
  `RunCard`. The dashboard (`pages/dashboard-content.tsx`) assembles
  `MetricCard`, `DashboardAgentCard`, `DashboardRunRow` and
  `DashboardScheduleRow` for itself.
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
    `?newWebhook=1` creates, `?editModel=<id>` edits, `?endUser=<id>` shows. A
    value is `1` when there is no object, the object's id otherwise (a composite
    value when a page holds several of them: `?editOauthClient=<authKey>:<ref>`).
    A param read by several components of one page must differ per component.
    Export the name when several entry points open the same modal
    (`NEW_SCHEDULE_PARAM`, `NEW_API_KEY_PARAM`, `SHARE_PARAM`).
  - **An object that may not exist**: `useModalTarget(name, items)` resolves the
    id against the loaded list and drops the param for an unknown id, so a stale
    link never leaves a modal on nothing. Create and edit are two params
    (`newProxy`, `editProxy`) sharing one form component; the host closes only
    the one that is open.
  - **Handing over** to another modal (`share` to `moveHome`): one navigation,
    `open(value, closing)`, never two modals stacked.
  - **After a creation** that shows a secret once, the creation's param goes
    away as the secret appears (`ApiKeyCreateModal`, `WebhookCreateModal`,
    `OAuthClientFormModal`): the secret has no address and does not survive a
    reload.
  - **A modal repeated on a page** is named by what the repeated thing already
    has that is stable: a map card by its relation id or, on the agent map, its
    concept (`?mapConcept=<card>`, `?mapCardList=<card>`), a tool of a catalog by
    `?inspectTool=<integrationId>:<tool name>` (the catalog answers only for its
    own integration). Full-screen maps are `?fullscreenMap=1`
    (`useMapFullscreen`). A modal opened over another has its own param
    (`?newModel=1` over `?mapPanel=model`).
  - **A pairing in progress** (`?connectProvider=<providerId>` in the
    onboarding) is a place too: its token lives in memory, so a reload reopens
    the modal and mints a new pairing instead of resuming the old one (which
    expires on its own).
  - **Without a URL, and only these**: (1) the confirmation of an act
    (`ConfirmModal`, the re-authentication that confirms one, the activation
    closure, the deletion of a chat thread): reopening « Supprimer X » from a
    link would be a trap; (2) the single display of a secret (`RevealedSecret`,
    `SecretRevealModal`, the key just created): the secret is not there after a
    reload; (3) the chat (`packages/module-chat`), whose message cards have no
    stable address; (4) what is not a modal, such as the notification bell, a
    popover that becomes a sheet on a phone. Each one is listed.
  - **The guard**: `components/test/modals-have-urls.test.ts` reads the sources
    and fails on a `Modal`, `PanelDialog`, `Sheet` or `…Dialog` whose `open` or
    `onClose` is driven by a `useState`, unless the pair is in its `EXCEPTIONS`
    list with one line of reason. The list also fails when an entry no longer
    matches code. Port the modal to `useModalParam` first; add an exception only
    for the four cases above.
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
  (`components/new-schedule-modal.tsx` is the reference). **Creating a package**
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
  form state with the choice, said by `ScheduleConnectionRefusals` wherever the
  write can be refused (Connexions and Identité of a schedule), not
  « Erreur d'enregistrement ». Any other refusal puts the control back on the
  stored value and is toasted, with no inline error under it (`ActorSelect` in a
  schedule's identity).
- **Tooltips** explain an icon or a disabled control, never carry the only copy
  of information. They are shadcn `Tooltip` wrapped in a `TooltipProvider`
  (`delayDuration` 250 or 300). A disabled control gets its reason through
  `DisabledReasonTooltip`.

## 11. Roles and permissions

- Same navigation for every role; what a role may not do is said where the
  content would be: `RoleLimitNotice` (`components/role-limit-notice.tsx`) in a
  section, a rail item with a lock.
- The « view as » preview (`ViewAsBanner`) is on every shell and on a refusal
  with no shell around it (the chat), and the product tabs judge the persona on its
  grants alone (its own conversations do not count).
- An action the role cannot perform is **not offered**. When it must stay
  visible to explain itself, it is disabled with its reason
  (`DisabledReasonTooltip`, `components/disabled-reason-tooltip.tsx`). Never a
  button that ends in a 403 toast.
- A row's controls (a connection's rename and share, a model credential's edit,
  test, delete and reconnect) follow the row's `allowed_actions`, which the API
  computes for the caller; never re-derive them from permissions and ownership
  in the component. The lab fixtures carry the field, the lab handlers rewrite it
  for the persona.
- A choice lists only what the caller may pick (an actor who can run agents, a
  connection the actor can reach).
- Who reaches a route is declared once in `lib/route-access.ts` and enforced by
  `RouteGate`; read permissions with `usePermissions().can(...)`. The « view as »
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
- **Code and JSON editors** are Monaco, only through the lazy facade
  `components/monaco/index.tsx` (`MonacoEditor`, `MonacoDiffEditor`; self-hosted,
  never import `monaco-editor` elsewhere). `JsonEditor` for a JSON value,
  `package-editor/content-editor.tsx` for typed text (it owns its text from mount,
  push new text by remounting with a `key`), `DraftDiffView` for a diff.
- **Read-only data**: `JsonView` (collapsible tree with copy), `Markdown`
  (`components/markdown.tsx`, lazy), `LogViewer` for a run's journal.

## 13. Chat

The chat is `@appstrate/module-chat` (UI in `packages/module-chat/src/ui/`, built
on assistant-ui) inside the shared shell (`modules/chat/chat-shell.tsx`). It
uses `@appstrate/ui` primitives and the host's `t` (`chat.json`), it cannot
import from `apps/web`. A tool call is a `ToolCallCard` (`tool-uis.tsx`),
reasoning a collapsible group (`reasoning.tsx`), a run started from the chat a
`ChatRunProgressCard`, the model picker `model-select.tsx`. The thread sits on the
canvas, surfaces on it are white cards, and heights hold across states (no jump).

## 14. Modules and feature gating

A surface served by an optional module reads its flag:
`useAppConfig().features.<flag>` (`agentMap`, `chat`, `webhooks`, `oidc`,
`billing`, `mcp`, `custom_roles`…). Without the module the entry leaves the
screen (a settings section, a nav item, a tab); it never opens on a 404. A route
that needs a module says so in `lib/route-access.ts` (`feature`). The lab turns
every module on (`lab/install.ts`).

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
- No development wording in the product (« à brancher », « dev », TODO). A control
  not wired yet is rendered only under `import.meta.env.DEV` (the global search in
  `shell-frame.tsx`), never as a disabled button in a production build.
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

## 18. The lab

`apps/web/src/lab`: the app served from typed fixtures (`bun run dev:lab` in
`apps/web`, `VITE_LAB=1`). A new screen ships with its fixtures (`fixtures.ts`,
typed from the OpenAPI response) and handlers (`handlers.ts`), and a row in
`e2e/lab/screens.mjs`, so it can be reviewed without an API. Its panel switches
the scenario (nominal, empty, heavy, error) and the role (owner, admin, member,
guest, plus the space preset). `e2e/lab/shots.mjs` captures every screen and
fails on a missing fixture: compare before and after a change;
`e2e/lab/detail-contract.mjs` freezes the agent and run detail geometry. The lab
is not proof of behaviour: a change that touches what the API accepts is also run
against a real instance.

## Checklist before handing UI work over

- [ ] Uses the pattern of this file for each need; a new pattern added here.
- [ ] Every role: same tabs, locked content explained, no 403 toast.
- [ ] Light, dark, 1440 px and 390 px; nominal, empty, heavy and error in the lab.
- [ ] fr and en, no literal string, no raw server text.
- [ ] Lab fixtures updated; `bun test` and `bun run typecheck` in `apps/web`,
      `bun run check` from the root.
