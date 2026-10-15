# Ménage UI — second passage (après #2011)

Statut : **lot 1 exécuté** (react-select, chaînes `bg-card`, `<select>` brut) ; les autres lots restent à faire. Base mesurée : `origin/main` @ `d484a1c1d` (#2011 fusionnée le 2026-10-15).
Complète `web-ui-cleanup-post-1937.md`, dont les phases 0–5 sont faites.

## 1. Constat

Le levier « aligner sur shadcn natif » est **presque épuisé** :

- Primitives `packages/ui` : saines (24/32 identiques à l'amont, 8 à ≤ 12 tokens d'écart) ; `card`, `empty`, `progress`,
  `alert-dialog`, `combobox` ajoutées par #2011. Seule `item` manque, volontairement.
- Résidus mesurés sur `main` (hors tests) : 34 chaînes `rounded … border … bg-card` maison, 2 `animate-pulse`,
  7 `<input>` bruts, 2 `<select>` bruts, 22 `<button>` bruts (dont une partie légitime : lignes cliquables, liens de rail),
  0 `<table>` brut, 0 import direct de `Dialog`/`Sheet`.
- #2011 a retiré ≈ 3,9 k lignes de code et ≈ 4,9 k de commentaires. Le code n'a pas fondu : `apps/web/src` hors tests
  fait **76,1 k lignes brutes** contre 61,6 k avant #1937 (+24 %), `packages/ui` 5,4 k contre 3,7 k ; 661 fichiers contre 441.
- **289 fichiers neufs = 28,6 k lignes** (11,8 k dans `components/` hors sous-dossiers, 2,75 k dans `lib/`). Ce sont des
  fonctionnalités, pas des primitives réécrites : le reste de la réduction passe par des **décisions produit**, pas par du
  remplacement de composants.

## 2. Ce qui reste, mesuré

| Cible                             | État sur `main`                                                                          | Gain visé (non prototypé, ±25 %) | Décision                                                 |
| --------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------- | -------------------------------------------------------- |
| Modales à URL (D-P5)              | `use-modal-param.ts` 234 + `modal-route.ts` 211 + test 309 ; 95 usages dans ~35 fichiers | −450 … −700                      | voie médiane : URL seulement pour édition/détail/partage |
| `react-select` dans `schema-form` | encore importé par `packages/ui/src/schema-form/widgets.tsx`                             | −1 dépendance, −60               | remplacer par `Combobox` local (déjà ajouté)             |
| `dnd-kit` (3 paquets)             | `agent-editor/schema-field-list.tsx` (560 l.)                                            | −60, −3 dépendances              | boutons haut/bas (D-P8)                                  |
| Catalogue d'organisation          | `org-catalogue-modal` 756 + `catalogue-preview` 634 + `catalogue-columns` 240            | −150 … −300                      | trancher fonctionnalité par fonctionnalité (D-M7)        |
| Rôles                             | `pages/org-settings/roles.tsx` 512 + `role-matrix.tsx`                                   | ≈ −250                           | garder une seule lecture (D-S5)                          |
| Journal de run                    | `log-viewer` 672 + `log-utils` 378 + `run-snapshot-inspector` 542                        | −160                             | inspecteur latéral vs développement en ligne (D-S6)      |
| Planifications                    | `schedule-settings` 624 + `new-schedule-modal` 368 + `frequency-composer` 323            | −100 … −150                      | `TimeField` natif, un seul composeur (D-M5)              |
| Création skills/intégrations      | pages de création à onglets conservées                                                   | −300 … −400                      | dialogue court comme pour les agents (D-P1, suite)       |
| Index packages                    | bascule cartes ⇄ tableau conservée (D-P3)                                                | −260 … −320                      | une seule vue                                            |
| `connection-choice-menu`          | 399 l.                                                                                   | −100                             | à rouvrir après les pickers                              |
| Dashboard                         | `dashboard-content` 422                                                                  | −60 … −130                       | modale « Ask AI », tuiles cliquables (D-S7/S9)           |
| Locales                           | miroir du catalogue de permissions (D-S12)                                               | −180                             | générer côté serveur                                     |
| Tests                             | 35,0 k lignes (hors code)                                                                | proportionnel aux coupes         | supprimer avec chaque coupe                              |

Total si toutes les recommandations sont prises : **≈ −2,5 à −3,5 k lignes de code**, plus les tests associés. Ordre de grandeur :
quelques pourcents de `apps/web`, pas un tiers. Une « grosse réduction » au-delà suppose de **retirer des écrans entiers**.

## 3. Lots proposés (une PR chacun, base `main`, `bun run check` vert)

1. **Mécanique sans décision** : `react-select` → `Combobox` ; passer les 34 chaînes `border bg-card` à `Card`
   (`git grep` liste les sites) ; `<input>`/`<select>` bruts → `Input`/`Select` ; revoir les 22 `<button>` bruts (garder
   ceux qui sont des liens de ligne). Corriger l'en-tête périmé de `web-ui-cleanup-post-1937.md`. Risque : bas.
2. **D-P5 voie médiane** : réduire `useModalParam`/`modal-route` aux modales d'édition/détail/partage ; les autres en
   `useState`. Risque : moyen (liens profonds, bouton retour) — vérifier au navigateur et via les tests e2e.
3. **D-P8 + D-P4** : `schema-field-list` sans `dnd-kit` ; revoir `react-virtual` (seul `log-viewer` l'importe).
4. **Catalogue, rôles, journal** : un lot par écran, après arbitrage de §4. Sans arbitrage, ne pas y toucher.
5. **Création skills/intégrations** en dialogue court. Risque : moyen (parcours d'onboarding).
6. **Clôture** : mesure LOC rejouée, `DESIGN_SYSTEM.md` à jour, `verify:dead-code` vert.

Parallélisme : lots 1, 3 et 5 touchent des fichiers disjoints ; le lot 2 touche ~35 fichiers et se fait seul.

## 4. Décisions à prendre avant les lots 4 et 5

D-M7 (quelles fonctions du catalogue garder), D-S5 (matrice ou liste des rôles), D-S6 (inspecteur ou ligne dépliée),
D-S7/S9 (tuiles cliquables, « Ask AI »), D-M5 (`<input type="time">` natif acceptable ?), D-P3 (une vue pour l'index).
Le détail et les recommandations sont dans `web-ui-cleanup-post-1937.md` §4.

## 5. Limites de cette analyse

- Lecture seule et comptages `rg`/`wc` ; **aucune mesure en navigateur**, aucun prototype. Les gains du §2 sont des
  estimations reprises du premier plan et recoupées sur les tailles de fichiers, pas des diffs écrits.
- Les 22 `<button>` bruts et les 34 chaînes `bg-card` n'ont pas été relus un par un : une partie est justifiée.
- La suite e2e Playwright n'a pas été rejouée après #2011 (la PR le note : label `e2e` non posé).
