# Plan de ménage UI post-#1937 — `apps/web` + `packages/ui`

Statut : **phases 0 à 5 exécutées par #2011** (plus les coupes D-M3, D-M4 et D-P1 pour les agents). Le reste est
suivi dans `web-ui-cleanup-round-2.md`. Les sections ci-dessous décrivent le plan tel qu'il était avant exécution.
Base du diagnostic : `main` @ `2b2148ea0` (PR #1937 fusionnée, parent `6ffa3d05b`).
Méthode : 5 audits en lecture seule (tables/listes · dialogues/formulaires · shell/primitives ·
packages/agents · intégrations/runs/réglages), comparaison de chaque primitive au registre shadcn
(`shadcn view` / `add --dry-run --diff`), comptage des importeurs par fichier. Les affirmations
structurantes ont été revérifiées à la main (voir §1.3). **Aucune mesure en navigateur** : tout ce qui
touche au rendu est à valider visuellement avant fusion.

---

## 1. Diagnostic

### 1.1 Ce que la PR a ajouté, et où est vraiment le poids

|                                                | Avant | Après                                                      |
| ---------------------------------------------- | ----- | ---------------------------------------------------------- |
| `apps/web/src` hors `schema.d.ts` (hors tests) | —     | ~84 k lignes (66 k code, 12,7 k commentaires, 5,4 k vides) |
| `apps/web` + `packages/ui` dans la PR          |       | +65 862 / −29 150                                          |
| Tests web                                      |       | 36 k lignes, 271 fichiers                                  |

### 1.2 Verdict : le diagnostic de départ est vrai à moitié

**Faux : « les composants shadcn ont été réécrits ».** Les 32 primitives de `packages/ui` ont été comparées
une à une au registre : 24 sont identiques à l'amont, 8 divergent de ≤ 12 tokens, tous justifiés
(i18n du bouton de fermeture, hauteur max du dialog, syntaxe Tailwind 4 de la sidebar). La PR a même
_rapproché_ `field`, `dropdown-menu`, `select`, `command` de l'amont. **Il n'y a rien à « reverter » dans les
primitives.**

**Vrai : la surcharge est dans les couches maison au-dessus.** Ce que la PR a introduit :

1. Une pile « tableau » entière, absente avant : `DataTable` (760 l., table CSS-grid avec rôles ARIA
   refaits à la main, colonnes redimensionnables, colonnes collantes pilotées en JS), `ListToolbar` (563 l.,
   deux mises en page quasi identiques), 27 fichiers `*-columns`, 6 wrappers `*-table`. ≈ 9,1 k lignes + 2,2 k de tests.
2. Des doublons fonctionnels : deux éditeurs de package (page + intégré, jusque dans `ResourceSection` qui
   contient deux implémentations complètes), deux explorateurs de fichiers + une table du même index, un
   second formulaire de création de modèle (`ModelFormModal`) qui refait ce que `ProviderAddFlow` fait déjà,
   deux jeux de contrôles température/raisonnement, deux éditeurs de `tools_policy`.
3. Des composants maison à la place de primitives shadcn **non installées** : `Card`, `Empty`, `Progress`,
   `AlertDialog`, `Item`. Conséquence : ~85 chaînes `rounded border bg-card` dans 60 fichiers, 56 `EmptyState`
   maison, confirmations en simple `Dialog` (un clic extérieur les ferme), `DialogDescription` utilisé
   **0 fois**.
4. Des surfaces produit nouvelles et coûteuses qui n'ont rien à voir avec shadcn (modales à URL, autosave de
   planification, carrousel, matrice de rôles…) : ce sont des **décisions produit**, pas du ménage.
5. Des commentaires/docblocks massifs (16 % du code ; jusqu'à 74 % sur `run-context.ts`).

### 1.3 Vérifié à la main

- `breadcrumb.tsx` (shadcn) : **0 importeur**, alors que `shell-breadcrumb.tsx` refait un fil d'Ariane.
- `DialogDescription` : **0 usage** dans `apps/web/src`.
- `styles.css:312` `[data-slot="dialog-overlay"] ~ …` : **règle morte** (`dialog.tsx` n'a aucun `data-slot`) ;
  le comportement « seul le premier overlay assombrit » documenté n'existe pas → bug visuel latent probable
  (empilement paramètres → dialogue).
- `carousel.tsx` (245 l.) : **1 seul consommateur** (`dashboard-content.tsx`).
- `ToolsPolicySection` : 1 seul usage (`pages/package-editor.tsx:516`), fallback d'un second éditeur de la même clé.
- `ModelFormModal` : création uniquement depuis `onboarding/model-step.tsx` ; `org-settings/models.tsx` s'en sert
  en édition, et monte `ProviderAddFlow` pour la création.
- `ShellSidebar` : un seul appelant (`app-sidebar.tsx`), `ShellHeader` un seul (`app.tsx`).

### 1.4 Honnêteté sur l'ordre de grandeur

Le ménage « shadcn natif + dédoublonnage » sans retirer aucune fonctionnalité plafonne vers **−7 à −8 k lignes
(≈ 8–9 % du code web)**, dont ~2 k de commentaires/locales. **Une « grosse réduction » (−12 k et plus, ≈ 14 %+)
passe par des coupes de fonctionnalités** listées en §4 : c'est à toi de les trancher, je n'en ai supposé aucune.

| Domaine                          | Sans coupe (code)                         | + commentaires/locales    | Avec décisions          |
| -------------------------------- | ----------------------------------------- | ------------------------- | ----------------------- |
| A. Tableaux/listes               | −820                                      | −450                      | −1 075 … −1 315         |
| B. Dialogues/formulaires/pickers | −1 000 (dont +110 `alert-dialog`)         | −400                      | −2 350 … −2 900         |
| C. Shell/états/atomes            | −1 110 (net −1 178 après +214 vendorisés) | −280                      | −1 720 net              |
| D. Packages/agents               | −1 550                                    | −450 (+400 hooks/lib)     | −3 300 … −3 500 de plus |
| E. Intégrations/runs/réglages    | −1 100 … −1 400                           | −400 … −500, locales −220 | −600 … −700 de plus     |

Recoupements entre domaines (Card, ToneBadge, DataTable) : ne pas additionner à la lettre ; fourchette réaliste
globale **sans décision ≈ −6 k code, −2 k commentaires/locales ; avec toutes les décisions recommandées ≈ −11 à −12 k**.
Les tests suivent (≈ −3 k).

---

## 2. Principes d'exécution

1. **Fondations d'abord** (primitives manquantes), puis balayages mécaniques, puis refontes structurelles, puis coupes produit.
2. **Un chantier = une PR courte**, base `main`, `bun run check` vert, tests touchés relancés. Aucune PR « big bang ».
3. **API publique stable pendant la transition** pour les composants très importés : `EmptyState` (56), `ErrorState` (40),
   `TextSkeleton` (44), `SettingsSkeleton` (30), `DetailSectionCard` (31), `PageHeader`, `FormItem` (61), `Modal` (44),
   `DataTable` (≈ 60 importeurs). On change l'intérieur, on migre les appelants ensuite.
4. **Pas de code transitionnel** (doctrine du dépôt, `docs/NO_TRANSITIONAL_CODE.md`) : un composant remplacé est supprimé
   dans la PR qui finit la migration, pas laissé en alias.
5. **Validation visuelle obligatoire** (navigateur 375 / 768 / 1440, clair + sombre) avant fusion de tout ce qui change le rendu ;
   label `e2e` sur les PR qui touchent au shell ou aux tableaux (testids `org-switcher-*`, `org-item-*`, `space-item-*` utilisés par Playwright).
6. **Mesure** : script de LOC (code / commentaire / vide) figé en Phase 0, rejoué à la fin de chaque phase pour suivre le gain réel.
7. **Exécution par agents** (si tu le souhaites) : agents Sonnet sur fichiers disjoints, relecture de chaque diff par moi,
   pas de commit pendant que des agents éditent.

### Décisions d'outillage (recommandées)

- **Ne pas migrer le style shadcn** (`"style": "default"`, pré-`data-slot`) : churn énorme, aucun gain LOC.
- **Ne pas ajouter `@tanstack/react-table`** : aucun écran ne trie ni ne pagine côté client ; la visibilité des colonnes tient en ~20 lignes.
- **`shadcn add` = risqué** : chaque ajout écrase `button`, `input`, `textarea`, `separator` et réécrit les conventions
  locales (`../cn.ts`, en-tête SPDX, suffixes `.tsx`). Procédure : `add <c> --dry-run`, `--diff` fichier par fichier,
  puis restauration git des 4 fichiers écrasés et ré-application des conventions. `combobox` n'existe pas pour ce style → wrapper local.
- Ne pas inliner les hooks qui enveloppent un seul appel `$api` (79 recensés, gain < 120 lignes, invalidations dispersées).

---

## 3. Phases

### Phase 0 — Garde-fous (1 PR, ~0 LOC)

- Script de mesure LOC versionné dans `scripts/` (code / commentaire / vide, hors `schema.d.ts` et tests) + baseline.
- Captures de référence des écrans clés (runs, agents, catalogue, membres, fournisseurs, détail run, éditeur) clair/sombre, 3 largeurs.
- Liste des testids Playwright à préserver (`e2e/pages/sidebar.ts`, `personal-spaces.ui.spec.ts`).

### Phase 1 — Zéro risque, sans dépendance (≈ −1 300 à −1 800 lignes) — PR parallélisables

1. **Régime commentaires** : docblocks > 12 lignes ramenés à l'essentiel (cible ≤ 15 % par fichier, convention du dépôt) ;
   garder le bloc SECURITY de `file-viewer.tsx`. Fichiers principaux : `data-table`, `list-toolbar`, `org-catalogue-modal`,
   `use-integrations`, `package-file-tree`, `use-global-run-sync`, `run-context`, `agent-editor/*`, `share-package-dialog`.
2. **Code mort** : `schemaToFields`, `NewPathRejection`, `PackageFileEntry` redéclaré, branche `badge` de `nav-org`, `sidebar-nav-link`
   (`children` jamais passé), `overview-card-action` (1 appelant), `model-availability-badge` (2), `statusVariantMap` (identité).
3. **Règle CSS morte** `styles.css:312` : ajouter `data-slot` aux overlays dialog/sheet **ou** supprimer la règle — à trancher _après_
   test visuel d'un empilement (paramètres → dialogue). Corrige probablement un bug réel.
4. **Locales** : fusionner ~113 clés à valeur dupliquée (≈ −220 lignes ; ex. « Plus d'actions pour {{name}} » sous 11 clés). `api-error-codes.test.ts` garde-fou.
5. **Doc** : corriger `DESIGN_SYSTEM.md` (référence à `chat-shell.tsx` inexistant, « ~28 sites » de `SectionCard` = 9) et le réduire (60 Ko).

### Phase 2 — Fondations `packages/ui` (≈ +300 lignes vendorisées, 1 PR par primitive)

- `card` (adapter une fois les défauts : `CardHeader p-6` / `CardTitle text-2xl` → valeurs du dashboard, plutôt que de surcharger partout).
- `empty` (`EmptyMedia variant="icon"`), `progress`, `alert-dialog`.
- `Combobox` local (~60 l.) : Popover + Command + coche ; remplace 8 combobox faits main.
- **Variantes `Badge` / `Alert`** (`success`, `warning`, `info`, `running`, `pending`, `failed`) absorbant `ToneBadge`/`ToneAlert` (51 sites, renommage mécanique).
- `DialogContent` : prop de bouton de fermeture (supprime la chaîne `[&>button]:…` dupliquée) ; `Modal` : prop `description` toujours rendue (sr-only par défaut) → corrige l'accessibilité sur 44 sites ; retirer la prop `open` (41/44 appelants passent `open`).
- `item` : **à ne pas ajouter d'office** (194 lignes pour ~8 sites ; les audits divergent) — réévaluer après la Phase 3 sur le nombre réel de sites (`ChoiceCard`, `RunRow`, lignes `HealthCard`, liste des partages).

### Phase 3 — Balayages mécaniques d'adoption (1 PR par balayage, sites listés par `git grep`)

- `ConfirmModal` / `UnsavedChangesModal` → `AlertDialog` (+ thread-list de `module-chat`, 1 confirm maison) ; `keepOpenOnRefusal` et `createConfirmer` conservés.
- `EmptyState` : intérieur réécrit sur `Empty`, signature inchangée (56 sites intacts) ; idem fallbacks de `notification-bell` et `error-boundary`.
- `SectionCard`, `DetailSectionCard` (31), `MetricCard`, `PlanCard`, `PackageCard` → `Card` composé.
- `UsageBar`, jauge de contexte du run → `Progress` ; `run-warnings` ×3 `HealthCard` → `Alert`.
- `space-y-*` → `flex flex-col gap-*` (205 occurrences / 99 fichiers), `h-N w-N` → `size-N` (72), retrait des `size`/`size={N}` sur icônes dans `Button`/`DropdownMenuItem` (16 directs + 78 props `size`), micro-badges maison (≈ 8) → `Badge`, callouts maison (≈ 7) → `Alert`, 3 `border-t` → `Separator`.
- Hiérarchie de champs : `FormItem` (seul wrapper, reconstruit sur `Field`/`FieldLabel`/`data-invalid`), `CheckboxField` et `OrgRoleOptions` → `Field orientation="horizontal"`, `SettingRow` rebasé sur `Field` ; règle : `useAppForm` ≥ 2 champs validés, `useState` en dessous, jamais `useForm` nu.
- Ajouter des règles ESLint (`no-restricted-syntax` / `no-restricted-imports`) pour empêcher la régression : `space-y-`, `animate-pulse` hors Skeleton, import direct de `Dialog` pour une confirmation.

### Phase 4 — Dédoublonnages structurels sans perte de fonctionnalité

Ordre libre sauf indication ; chacun est une PR.

1. **Supprimer `ToolsPolicySection`** (−140) au profit de `IntegrationToolsSection` ; vérifier le flux `/integrations/new` au navigateur.
2. **Fusion création de modèle** : onboarding passe sur `ProviderAddFlow` ; `ModelFormModal` devient édition seule (~230 l.) ; supprimer `discovery-controls`, branches de création de `lib/model-form-payload` et `lib/model-form-submit` (≈ −550 avec `lib`, −340 tests). Recette manuelle d'onboarding obligatoire (décision D-M1).
3. **Fusion contrôles de génération** (`model-generation-rows/fields` web vs `ModelGenerationControls` ui) : −140. Décision D-M2 (curseurs vs presets).
4. **`schema-form` sur composants natifs** : supprimer `primitives.tsx`, utiliser `Button/Input/Textarea/Checkbox/Label` (−90) ; `react-select` → `Select`/Popover+Command (−1 dépendance). Attention : hauteur d'`Input` `h-9` → `h-10` (changement visible).
5. **Pickers de connexion** : fusion des 4 états désactivés en un `StatusPicker` (−90), `ConnectionChoiceMenu` sur `DropdownMenuRadioItem/CheckboxItem` (−90), boutons d'`add-integration-connection` factorisés (−45).
6. **Éditeur de package à une seule surface** : supprimer la branche « carte » de `ResourceSection` (−215) et `MetadataSection` (−45), un seul `usePackageEditor` ; la page de création affichera la table de réglages (cf. décision D-P1 pour aller plus loin).
7. **Explorateur de fichiers** : scinder `PackageFilesView` (1072 → ~860 en 3 fichiers < 450), un seul `SaveBar`, un seul menu d'actions de fichier, un seul select de version (3 → 1), un seul wrapper Monaco (4 répétitions du thème) : ≈ −250.
8. **Menus d'actions** : `PackageActionsDropdown` (457, 25 props) + `AgentActions` (168) → liste déclarative d'items + un hook (~420).
9. **Shell** : fusion `shell-frame` + `app-sidebar` (`app-shell.tsx`), `shell-breadcrumb` sur `Breadcrumb*` (puis le primitif cesse d'être mort), `UserAvatar` unique dans `nav-user`, `org-switcher` dédoublonné (trigger écrit 2×, lignes dupliquées, `Command` au lieu d'`input` brut) : ≈ −330 ; `detail-tabs` sur `ScrollArea` + fusion `collection-tabs` : −58 ; `loading-skeletons` : −115 ; `app.tsx` : un helper `lazy` unique (41 blocs) + `.map` des routes d'onboarding : −160.
10. **Divers sûrs** : `settingsSections(type, caps)` pilotée par données (−120), aperçus d'intégration/package depuis une config (−120), `agent-integrations-block` en liste simple (−115, testids conservés), `memory-panel` / `version-history` (−140), `clients-table` (modal OAuth via `FormItem`, −85), `AdvancedSection` partagé entre `agent-input-form` et `new-schedule-modal`, `import-modal` / `create-version-modal` (`ToggleGroup`) / `fork-package-modal` allégés, `end-user-detail` via `FactGrid`.

### Phase 5 — Pile tableau (gated par D-T1…D-T3) : la PR à risque H

Pré-requis : Phases 2–3 faites ; décisions D-T1…D-T3 tranchées.

1. `collection.ts` + `collection-frame.tsx` fusionnés ; `ViewToggle` → `ToggleGroup` ; `ListToolbar` à une seule disposition (563 → ~270) ; `useColumnVisibility` renvoie `{columns, menu}` (6 pages).
2. Inliner les 5 `*-table.tsx` dans leurs pages/listes (−100) ; le dernier (`invitations-table`) reste.
3. **`DataTable` sur le `Table` shadcn** en gardant exactement les props publiques (le type `DataColumn<T>` existant suffit comme « helper de colonnes ») : ligne = lien couvrant (`tr relative` + `td` absolu), tiers via classes container-query, colonnes identité/actions `sticky`, skeleton/vide/erreur conservés. 760 → ~220 (sans redimensionnement) ou ~440 (avec). Réécrire `data-table.test` (287 → ~130) ; `column-tiers.test` (415) réduit à l'invariant « une colonne de contrôle n'a pas de tier » (~60) ; supprimer `row-actions-one-way.test` (230 l. qui regexent du TSX) ou le déplacer en règle ESLint.
4. Codemod des chaînes `width` (`minmax(Npx,Xfr)`) vers des planchers numériques ; identité de cellule partagée (icône + nom + sous-ligne, répétée 11×) ; ≈ −200 sur les 27 fichiers `*-columns`.
5. Retirer la surcharge `[[data-settings-table-surface=integrated]_&]` de `settings/layout.tsx`.
   Validation : runs, fichiers, agents, catalogue, membres, fournisseurs, webhooks à 375/768/1440 ; `request-fanout.test`, `org-settings-models-tables.test`, `integration-columns.test`.

### Phase 6 — Coupes produit (chacune sa PR, uniquement celles que tu valides en §4)

Chaque coupe retire aussi ses clés de locales, ses tests et sa doc.

### Phase 7 — Clôture

- Rejouer la mesure LOC, publier le delta par domaine.
- Mettre à jour `DESIGN_SYSTEM.md` (tableau, états, modales, formulaires) ; ajouter les règles ESLint qui empêchent la régression ; `verify:dead-code` (knip) vert.
- Rétrospective : ce qui n'a pas bougé et pourquoi.

---

## 4. Décisions qui te reviennent (aucune supposée)

Gain = lignes de code, hors tests/locales. **Recommandation** en gras.

### Tableaux / listes

| #    | Décision                                                                          | Gain                        | Reco                                                                      |
| ---- | --------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------- |
| D-T1 | Colonnes **redimensionnables** (glisser, double-clic, flèches, largeur persistée) | −190 (+ store 26, tests 35) | **Couper** (règle posée dans la doc, aucun ticket cité)                   |
| D-T2 | Colonnes figées avec ombres de bord et relâchement auto en JS                     | −90                         | **Couper** (garder `sticky` simple)                                       |
| D-T3 | Colonnes lues qui _disparaissent_ par palier vs défilement horizontal seul        | −70 (+ test 415)            | **Garder les paliers** via classes container-query, couper l'arithmétique |
| D-T4 | Bascule **table ⇄ cartes** sur runs, plannings, fichiers, intégrations            | −240 (+104 test)            | **Couper** (garder les cartes de packages)                                |
| D-T5 | Menu de **visibilité des colonnes** persisté (6 écrans)                           | −190                        | Garder (peu coûteux après la fusion de hooks)                             |
| D-T6 | Filtres derrière un bouton vs barre inline                                        | −45                         | À voir en navigateur                                                      |
| D-T7 | Survol/clic de **ligne entière** vs `onClick` sur le nom                          | −30                         | Garder                                                                    |

### Packages / agents

| #    | Décision                                                                                            | Gain                          | Reco                                                                          |
| ---- | --------------------------------------------------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------- |
| D-P1 | Création : page multi-onglets `/x/new` vs **petit dialogue** (nom, description, modèle) puis détail | −480                          | **Dialogue** (la poignée chat/manuel existe déjà)                             |
| D-P2 | Table « Contenu » (inventaire rôle + taille)                                                        | −140                          | **Couper / replier dans l'explorateur**                                       |
| D-P3 | Index des packages : cartes **et** table + visibilité par liste                                     | −260 … −320                   | **Une vue**                                                                   |
| D-P4 | Arbre de fichiers : virtualisation                                                                  | −60                           | **Couper la virtualisation seule** (garder le clavier WAI-ARIA)               |
| D-P5 | Modales à URL partout (69 sites, infra 319 l. + test 309)                                           | −450 … −700                   | **Voie médiane** : URLs seulement pour édition/détail/partage (10–12 modales) |
| D-P6 | **Dossiers de dépendances** dans l'explorateur (skills, serveurs MCP)                               | −280 (+ 3 requêtes/ouverture) | **Couper**                                                                    |
| D-P7 | Éditeur d'apparence d'agent complet                                                                 | −60 … −90                     | Curer la liste d'icônes                                                       |
| D-P8 | Réordonnancement des champs en drag & drop (dnd-kit) vs boutons haut/bas                            | −60 (−3 dépendances)          | **Boutons**                                                                   |

### Dialogues / modèles / planification

| #    | Décision                                                                                          | Gain                                                            | Reco                                         |
| ---- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------- |
| D-M1 | Onboarding : un modèle unique vs `ProviderAddFlow` (clé + plusieurs modèles)                      | inclus Phase 4                                                  | **`ProviderAddFlow`**                        |
| D-M2 | Température/raisonnement : presets nommés (selects) vs curseurs                                   | −140                                                            | Au choix, mais un seul                       |
| D-M3 | **Autosave par champ** des planifications vs formulaire + bouton Enregistrer                      | −250 (−100 lib)                                                 | **Formulaire explicite**                     |
| D-M4 | Refus d'écriture de planification **résolu en place** vs toast + navigation                       | −300 … −450                                                     | Toast + lien                                 |
| D-M5 | `TimeField` : 3 selects vs `Input type=time` natif                                                | −65 (risque : « 09:30 AM » en UI française selon le navigateur) | Natif si acceptable                          |
| D-M6 | `PanelDialog` : bandeau qui apparaît au défilement                                                | −35                                                             | **Couper**                                   |
| D-M7 | Overlay catalogue : deux lectures (cartes/matrice), activation en masse, vue « partagés », aperçu | −150 … −300                                                     | À trancher fonctionnalité par fonctionnalité |

### Shell / dashboard / réglages / runs

| #     | Décision                                                                   | Gain                                       | Reco                                  |
| ----- | -------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------- |
| D-S1  | **Carrousel** du dashboard                                                 | −305 (+ dépendance `embla-carousel-react`) | **Couper**                            |
| D-S2  | Sélecteur org/espace à deux colonnes vs `DropdownMenu` natif               | −154 vs −244                               | Garder le comportement, dédoublonner  |
| D-S3  | Anneaux concentriques de l'état vide vs `EmptyMedia` standard              | −30                                        | Standard                              |
| D-S4  | Skeletons qui lisent le cache de requêtes pour le titre                    | −45                                        | **Couper**                            |
| D-S5  | Matrice des **rôles** (bascule liste/matrice)                              | −250                                       | À trancher                            |
| D-S6  | **Inspecteur latéral** des logs (vs développement en ligne)                | −160                                       | À trancher                            |
| D-S7  | Tuiles de stats cliquables + actions de pied de carte (vue d'ensemble run) | −130                                       | À trancher                            |
| D-S8  | Portail d'actions de page des réglages                                     | −50                                        | Couper                                |
| D-S9  | Modale « Ask AI » du dashboard                                             | ~−60                                       | À trancher                            |
| D-S10 | 9 exports `Sidebar*` inutilisés                                            | −150                                       | **Garder** (diff propre avec l'amont) |
| D-S11 | Styles globaux d'éléments bruts `styles.css:216-245`                       | −30 CSS + churn                            | **Différer** (risque élevé)           |
| D-S12 | Clés `settings:permissions.label.*` (miroir du catalogue serveur)          | −180                                       | Générer côté serveur ou accepter      |

**Total si tu prends toutes les recommandations en gras : ≈ −4,5 à −5 k lignes supplémentaires** au-delà du ménage sans coupe.

---

## 5. Risques et parades

| Risque                                                                                                                  | Parade                                                                              |
| ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Régressions visuelles (≈ 30 tables, `table-fixed` + `<col>`, couverture de ligne `td` absolue non testés en navigateur) | Prototype sur 2 écrans avant codemod ; captures avant/après ; `request-fanout.test` |
| Testids Playwright du shell                                                                                             | Liste figée en Phase 0 ; label `e2e`                                                |
| `shadcn add` écrase `button/input/textarea/separator`                                                                   | Procédure `--dry-run` + restauration git (§2)                                       |
| Accessibilité (arbre de fichiers, tables, alert-dialog)                                                                 | Garder le modèle clavier WAI-ARIA ; tests statiques existants                       |
| Tests « exportés pour les tests » (`RunInputFacts`, `ModelFallbackCard`…)                                               | Réécrire en même temps que le composant, ne pas supprimer les tests                 |
| Changement de hauteur d'`Input` (`h-9` → `h-10`) dans `schema-form`                                                     | Validation visuelle ; décision explicite                                            |
| Conflits avec PR ouvertes touchant `apps/web`                                                                           | `git fetch` + rebase avant chaque PR ; chantiers sur fichiers disjoints             |
| Estimations ±20–25 % (lues, non prototypées)                                                                            | Mesure LOC réelle à la fin de chaque phase ; ajuster le plan                        |

---

## 6. Ce que ce plan ne fait pas

- Aucune migration de style shadcn, aucun `@tanstack/react-table`, aucune réécriture de `use-integrations` / `use-global-run-sync` (l'AGENTS.md interdit de convertir en `EventSource`).
- Ne touche pas `apps/api`, `packages/core`, `packages/module-*` (sauf la confirmation de suppression de fil dans `module-chat`, citée en Phase 3).
- Ne tranche aucune des décisions du §4.
