# Spécification: navigateur multi-onglets du pont desktop

Statut: spec de travail, protocole bridge v2. Complète le
`HANDOFF-desktop-bridge-browser.md`, qui décrit le contrat v1 (surface
unique).

## 1. Pourquoi

Le pont v1 expose **une seule surface Chromium** par utilisateur. Un bail
exclusif par `userId` (`lease.ts`) garantit qu'un seul run la pilote à la
fois. Trois limites en découlent:

- deux agents ne peuvent pas travailler en parallèle;
- un agent ne peut pas garder un contexte ouvert (une boîte mail) pendant
  qu'il en manipule un autre (un portail);
- l'utilisateur n'a aucun onglet à lui, la fenêtre est soit le SPA, soit
  la surface de l'agent.

La v2 introduit des onglets, une propriété explicite par onglet, et des
profils de session séparés.

## 2. Modèle

### 2.1 Onglet

Un onglet est une `WebContentsView` plus des métadonnées:

```ts
interface Tab {
  tabId: string; // "tab_" + uuid, minté par le desktop
  owner: TabOwner;
  state: "idle" | "driving" | "paused_by_user" | "closed";
  partition: string; // profil de session, voir §2.3
  authorizedUris: string[]; // périmètre du propriétaire, vide pour un onglet user
  title: string;
  url: string;
}

type TabOwner = { kind: "user" } | { kind: "run"; runId: string; agentName: string };
```

Règles de propriété:

1. Un run ne pilote que les onglets dont il est propriétaire. Un onglet
   `user` n'est jamais pilotable, sans exception ni transfert.
2. Un run obtient un onglet via `tabs.open`. Il ne peut pas s'approprier
   un onglet existant.
3. Les onglets d'un run sont fermés à son statut terminal (hook
   `onRunStatusChange`, déjà en place dans `index.ts`).
4. Une popup (`window.open`, `target="_blank"`) ouverte depuis un onglet
   hérite du propriétaire ET des `authorized_uris` de l'onglet ouvrant.
   Jamais de transfert entre runs: une popup issue d'un onglet `user`
   reste `user`.

### 2.2 États et reprise en main

`driving` est l'état nominal d'un onglet de run. Toute interaction
humaine directe (clic, frappe, navigation via la barre d'URL) le fait
passer en `paused_by_user`: les commandes agent sur cet onglet répondent
409 `tab_paused` jusqu'à ce que l'utilisateur rende la main via la barre
d'onglets.

C'est le mode hybride volontairement supporté: l'humain franchit ce que
l'agent ne peut pas franchir (2FA matérielle, SSO, défi anti-bot), puis
rend la main.

### 2.3 Profil de session

Une partition Chromium est le classeur des cookies, du `localStorage` et
du cache. La v1 en utilise une seule, partagée par tous les runs, ce qui
signifie que **la session ouverte par un agent reste disponible pour le
suivant**. L'isolation v1 est temporelle, pas informationnelle.

La v2 rend le profil déclaratif, au même titre que `authorized_uris`:

```json
{
  "runtime_tools": ["desktop_browser"],
  "desktop_browser": {
    "authorized_uris": ["https://portail.example.com/**"],
    "session": "agent"
  }
}
```

| Mode             | Clé de partition                          | Persistance                                     | Usage                                                 |
| ---------------- | ----------------------------------------- | ----------------------------------------------- | ----------------------------------------------------- |
| `isolated`       | `appstrate-run-<runId>` (sans `persist:`) | mémoire, jetée en fin de run                    | agents sensibles, ou qui se reconnectent à chaque run |
| `agent` (défaut) | `persist:appstrate-agent-<scope>-<name>`  | disque, réutilisée entre les runs du même agent | cas courant                                           |
| `user`           | `persist:appstrate-browser-<profil>`      | disque, partagée avec l'humain                  | mode hybride assumé, opt-in                           |

La clé est calculée **côté plateforme** depuis le manifeste et transmise
au desktop dans `tabs.open`. Le desktop ne la déduit jamais lui-même.

Invariant accepté et documenté: **deux runs du même agent partagent son
profil.** Ils ont le même périmètre d'autorisations et les mêmes
intégrations déclarées, donc le partage n'accorde rien qu'un run n'ait
déjà.

## 3. Protocole bridge v2

### 3.1 Négociation

Le desktop se connecte à `/api/desktop/bridge?protocol=2`. Le serveur
accepte `1` et `2`, et retient la version par client. Un client v1 ne
reçoit jamais de verbe `tabs.*`; les commandes desktop d'un agent
multi-onglets échouent alors en 503 avec un message explicite plutôt que
d'être silencieusement appliquées à la surface unique.

### 3.2 Champ `tab_id`

Toutes les commandes `browser.*` existantes acceptent `tab_id` dans leur
enveloppe (pas dans `params`, qui reste le domaine de la méthode):

```json
{
  "jsonrpc": "2.0",
  "id": "…",
  "method": "browser.fill",
  "tab_id": "tab_…",
  "params": { "selector": "#password", "value": "…" },
  "meta": { "authorized_uris": ["https://portail.example.com/**"] }
}
```

Une commande d'agent se reconnaît à `meta.run_id` et **doit** nommer son
`tab_id`: sans cela elle serait appliquée à l'onglet du moment, c'est à
dire à une surface que la plateforme ne lui a pas louée. Elle échoue en
`-32602`.

Une commande utilisateur (`/api/desktop/me/command`, pilotage manuel) n'a
pas de `run_id` et peut omettre `tab_id`: elle agit alors sur l'onglet
actif, ce qu'une personne appelle « le navigateur ».

La compatibilité descendante des agents est assurée côté plateforme, pas
côté wire: c'est la plateforme qui ouvre un onglet implicite pour un
agent qui n'en demande pas (voir §5).

### 3.3 Nouveaux verbes

| Verbe           | Params                                        | Résultat                              |
| --------------- | --------------------------------------------- | ------------------------------------- |
| `tabs.open`     | `{ partition, authorized_uris, background? }` | `{ tab_id }`                          |
| `tabs.close`    | `{ tab_id }`                                  | `null`                                |
| `tabs.list`     | `{}`                                          | `{ tabs: Tab[] }`                     |
| `tabs.activate` | `{ tab_id }`                                  | `null` (met l'onglet au premier plan) |

`tabs.open` est le seul verbe qui porte la partition. Une fois l'onglet
créé, sa partition est figée: Chromium fixe la session à la création de
la `WebContentsView`.

### 3.4 Notifications desktop vers plateforme

S'ajoutent aux notifications de téléchargement existantes:

| Notification  | Params                   | Effet plateforme                           |
| ------------- | ------------------------ | ------------------------------------------ |
| `tab.opened`  | `{ tab_id, owner, url }` | miroir du registre                         |
| `tab.closed`  | `{ tab_id, reason }`     | libère le bail, commandes suivantes en 410 |
| `tab.paused`  | `{ tab_id }`             | passe l'onglet en `paused_by_user`         |
| `tab.resumed` | `{ tab_id }`             | rend la main à l'agent propriétaire        |

### 3.5 Sérialisation

La v1 sérialise **toutes** les commandes sur une chaîne de promesses
unique (`client.ts`, `commandChain`). La v2 conserve une chaîne **par
onglet**: les commandes d'un même onglet restent strictement ordonnées
(le debugger CDP est attaché par `webContents`, deux commandes
concurrentes s'y détacheraient mutuellement), deux onglets progressent en
parallèle.

## 4. Baux et conflits

| Conflit                                                              | Réponse                                                                              |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Deux runs veulent le même onglet                                     | impossible par construction, un onglet appartient à un run et n'est jamais transféré |
| Un run dépasse son quota d'onglets                                   | 409 `tab_quota_exceeded` (défaut: 3 par run, 8 par utilisateur)                      |
| L'utilisateur a repris la main                                       | 409 `tab_paused`                                                                     |
| L'utilisateur a fermé l'onglet                                       | 410 `tab_gone`                                                                       |
| Navigation hors périmètre                                            | bloquée côté desktop, par onglet, avec les `authorized_uris` de cet onglet           |
| Deux runs concurrents sur la même origine, mode `user` ou même agent | bail par origine, le second attend ou reçoit 409 `origin_busy`                       |

Le bail par origine n'est nécessaire que là où une partition est
réellement partagée: le mode `user`, et deux runs du même agent. Les
profils `agent` et `isolated` distincts n'ont rien à s'échanger.

### 4.1 Invariant secrets

La v1 interdit de combiner substitution de credentials et
`browser.evaluate` dans un même run (`lease.ts`, `recordDesktopExposure`).
La sérialisation globale garantissait implicitement que deux runs ne
pouvaient pas contourner la règle à deux.

En v2, l'invariant est porté **par partition**: tant qu'un run détient
une exposition `credential_substitution` active, aucun autre run
partageant la même partition ne peut faire `evaluate`, et
réciproquement.

## 5. Compatibilité des agents existants

Un agent dont le manifeste ne mentionne ni `session` ni d'onglet:

- reçoit le mode `agent` (défaut), donc son propre profil;
- se voit ouvrir un **onglet implicite** par la plateforme à sa première
  commande `browser.*`, mémorisé pour la durée du run.

Aucun changement de manifeste n'est requis. Le seul effet visible est
qu'il ne repart plus de la session personnelle de l'utilisateur: les
agents qui se connectent eux-mêmes (substitution de credentials) ne
voient aucune différence après leur premier run, ceux qui dépendaient de
la session humaine doivent déclarer `"session": "user"` ou faire amorcer
leur profil une fois à la main.

Le module étant expérimental et opt-in via `MODULES`, ce changement de
défaut se fait maintenant ou jamais.

## 6. Découpage

| Lot | Contenu                                                                                               | Fichiers principaux                                                              |
| --- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 0   | cette spec                                                                                            | `doc/SPEC-multi-onglets.md`                                                      |
| 1   | TabManager desktop, sérialisation par onglet, guards par onglet, downloads corrélés par `webContents` | `apps/desktop/src/tabs.ts`, `main.ts`, `bridge/client.ts`, `bridge/downloads.ts` |
| 2   | bail par onglet, quotas, résolution de partition, nettoyage de fin de run                             | `lease.ts`, `routes.ts`, `registry.ts`, `index.ts`                               |
| 3   | `tab_id` et verbes `tabs.*` dans le contrat agent, onglet implicite                                   | `runtime-tools/desktop-browser/tool.ts`, `sidecar/mcp.ts`                        |
| 4   | barre d'onglets, badge agent, pause et reprise                                                        | `renderer/navbar.html`, `layout.ts`, `preload.ts`                                |
| 5   | tests dont anti-fuite séquentielle et concurrente                                                     | `test/unit`, `test/integration`                                                  |

## 7. Hors périmètre

- Redis et fan-out multi-réplique: inchangé, le registre et les baux
  restent en mémoire du processus API.
- Isolation par onglet à l'intérieur d'un même agent.
- Purge automatique des profils d'agents désinstallés: à traiter, mais
  hors du chemin critique.
