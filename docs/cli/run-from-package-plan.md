# Plan — `appstrate run` from package id + UI alignment

**Status:** Shipped. Commits: P1 83a8ad9, P2 c31dddf, P3 519fa8a, P4 bb4b8e8a, P5 (this commit).

> Statut : draft. Brainstorming validé, à transformer en phases GSD avant exécution.

## Objectif

Faire passer `appstrate run` du mode "exécute un fichier `.afps` que tu as sous la main" à un mode "exécute un agent par son id, avec la même config que dans l'UI". Trois manques actuels :

1. **Pas de résolution par id** — il faut un fichier local.
2. **Pas de gestion des connexions manquantes** — le resolver throw, l'utilisateur se débrouille.
3. **Config CLI ↔ UI désalignée** — `application_packages` (model, proxy, config), `connection_profiles` et `user_agent_provider_profiles` sont ignorés.

## État actuel — repères dans le code

| Surface                  | Référence                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Entrée commande          | `apps/cli/src/cli.ts:658` (`program.command("run")`)                                                                                 |
| Logique run              | `apps/cli/src/commands/run.ts` (`runCommandInner`)                                                                                   |
| Resolver providers (CLI) | `apps/cli/src/commands/run/resolver.ts` (mode `remote\|local\|none`)                                                                 |
| Reporting platform       | `apps/cli/src/commands/run/report.ts` → `POST /api/runs/remote`                                                                      |
| Modèles présets          | `apps/cli/src/commands/run/model.ts` (`env\|preset`)                                                                                 |
| API run par id           | `POST /api/agents/{scope}/{name}/run` (`apps/api/src/openapi/paths/runs.ts:4`)                                                       |
| API run inline           | `POST /api/runs/inline` (`runs.ts:210`)                                                                                              |
| API run distant          | `POST /api/runs/remote` (`runs.ts:596`) — accepte `providerProfiles`                                                                 |
| Export bundle aplati     | `GET /api/agents/{scope}/{name}/bundle?version=<spec>` (`.afps-bundle` avec deps pinnées, `X-Bundle-Integrity` header, déterministe) |
| Download single-package  | `GET /api/packages/{scope}/{name}/{version}/download` (ZIP brut, sans deps — pas utilisé par le CLI run)                             |
| Schéma profils           | `packages/db/src/schema/connections.ts`                                                                                              |
| Override per-agent       | `user_agent_provider_profiles` (table)                                                                                               |
| Config persistée         | `application_packages` (config, modelOverride, proxyOverride, versionPin)                                                            |

## Phases

### [done] Phase 1 — Run par id de package (bundle aplati)

**Goal** : `appstrate run @scope/agent[@spec]` télécharge le bundle aplati (avec deps) et exécute. Comportement local-only inchangé pour `appstrate run ./local.afps`.

La route `GET /api/agents/{scope}/{name}/bundle?version=<spec>` existe déjà — elle prend semver / dist-tag / range, retourne un `.afps-bundle` déterministe avec deps pinnées et un header `X-Bundle-Integrity`. Pas de travail côté serveur.

**Tâches** (CLI uniquement)

1. Détection d'argument (`apps/cli/src/commands/run.ts`) : si commence par `@` ou matche `^[\w-]+/[\w-]+(@.+)?$` → mode "id", sinon chemin.
2. Parser `<spec>` après `@` : `@scope/name@1.2.3`, `@scope/name@beta`, `@scope/name@^1.0.0`, `@scope/name` (laisser le serveur résoudre vers la version installée pour l'app, fallback `latest`).
3. Cache local `~/.cache/appstrate/bundles/{instanceHost}/{scope}/{name}/{version}-{integrityShort}.afps-bundle`. Clé inclut l'instance pour éviter le leakage cross-instance (R6 ci-dessous). Vérifier `X-Bundle-Integrity` avant réutilisation. Flag `--no-cache` pour bypass.
4. Téléchargement via `GET /api/agents/.../bundle?version=<spec>`. Si la spec est `latest` ou un range, ne pas cacher la résolution `spec → version` (elle peut bouger) — cacher uniquement `(version, integrity) → fichier`.
5. Brancher dans `runCommandInner` à la place de `readBundleFromFile(opts.bundle)` — `prepareBundleForPi` traite déjà les `.afps-bundle` multi-packages.

**Critères de succès**

- `appstrate run @system/hello-world` télécharge et exécute sans flag de plus.
- Agent avec 1+ skill : pas de téléchargement séparé des deps.
- 2e run = cache hit (vérifié via debug log).
- Erreurs explicites : `package_not_found`, `version_not_found`, `integrity_mismatch`.

---

### [done] Phase 2 — Config héritée depuis l'application

**Goal** : un run CLI avec profil + appli pinnés se comporte comme l'UI ("Run" depuis la page agent), ie. avec config / model / proxy persistés.

**Tâches** (côté plateforme)

1. Endpoint `GET /api/applications/{appId}/packages/{scope}/{name}/run-config` qui retourne le payload résolu :
   ```json
   {
     "config": { ... },
     "modelId": "claude-sonnet-4-6" | null,
     "proxyId": "..." | null,
     "versionPin": "1.2.3" | null,
     "requiredProviders": ["gmail", "clickup"]
   }
   ```
   Source unique consommée par UI **et** CLI — pas de duplication de la cascade.

**Tâches** (côté CLI) 2. Avant `runCommandInner` : si profil + appId disponibles, `GET …/run-config`. Merger dans cet ordre (priorité décroissante) :

1.  Flags CLI explicites (`--config`, `--model`, `--proxy`)
2.  Variables env (`APPSTRATE_MODEL`, `APPSTRATE_PROXY`)
3.  `run-config` retourné par l'API
4.  Ajouter `--proxy <id>` (manquant aujourd'hui).
5.  Flag `--no-inherit` pour ignorer entièrement `run-config` (cas CI déterministe).
6.  Si `versionPin` est posé et que l'utilisateur n'a pas spécifié `@spec`, l'utiliser.

**Critères de succès** : `appstrate run @scope/agent` reproduit le run UI à l'octet près (model, proxy, config, version) tant qu'aucun flag n'override.

---

### [done] Phase 3 — Profils de connexion côté CLI

**Goal** : aligner le CLI sur le modèle `connection_profiles` + `user_agent_provider_profiles` + `providerProfiles`.

**Tâches** (côté CLI — vocabulaire)

1. Garder `--profile` = auth profile (existant). Ajouter :
   - `--connection-profile <id|name>` (alias `--cp`) — default per-run.
   - `--provider-profile <providerId>=<id|name>` (repeatable) — override per-provider, mappé 1:1 sur `providerProfiles`.

**Tâches** (côté CLI — sticky default) 2. Nouvelle famille de commandes :

```
appstrate connections list
appstrate connections profile list
appstrate connections profile current
appstrate connections profile switch [ref]   # picker interactif si pas d'arg
appstrate connections profile create <name>
```

3. Persister le `connectionProfileId` choisi dans la config CLI (à côté de `appId`/`orgId`). Lecture par `runCommand` comme valeur par défaut, override par flag.

**Tâches** (côté CLI — résolution `<id|name>`) 4. Accepter UUID ou nom — `GET /api/connection-profiles?name=...` (à ajouter si absent) ou liste + filtre côté client.

**Tâches** (côté plateforme — local mode) 5. Auditer `apps/api/src/routes/credential-proxy.ts` : exposer un sélecteur (`X-Connection-Profile-Id` header ou query) pour permettre au resolver CLI in-process (mode `--providers=remote` sans `--report`) de cibler un profil. Sans ça, les overrides ne sont respectés qu'en run distant via `/api/runs/remote`. 6. Threader le profile id depuis `buildResolver` (`apps/cli/src/commands/run/resolver.ts`) dans les `extraHeaders` du proxy.

**Critères de succès**

- `appstrate connections profile switch work` puis `appstrate run @scope/agent` utilise le profil "work" pour tous les providers.
- `--provider-profile gmail=perso` override pour Gmail uniquement.
- `appstrate run` sans rien laisse le serveur appliquer sa cascade habituelle (override agent → default user).

---

### [done] Phase 4 — Preflight connexions manquantes + browser handoff

**Goal** : si une connexion requise manque, ne pas crasher mais guider vers l'UI.

**Tâches** (côté plateforme)

1. Endpoint `GET /api/agents/{scope}/{name}/readiness?connectionProfileId=...&providerProfile.gmail=...` qui résout exactement comme le run le fera et renvoie :
   ```json
   {
     "ready": false,
     "missing": [
       { "providerId": "gmail", "profileId": "...", "reason": "no_connection" | "needs_reconnection" | "expired" }
     ]
   }
   ```
2. Page web `/connect?providers=gmail,clickup&profile=<id>&return=cli` (ou réutiliser `/preferences/connectors?profile=<id>&highlight=...`) — décision à figer en début de phase.

**Tâches** (côté CLI) 3. Avant le run, appel readiness. Si `ready === true` → continue. 4. Si `ready === false` et TTY interactif :

- Afficher la liste des providers manquants.
- Prompt "Open browser to connect? [Y/n]" (clack).
- `open(1)` / `Bun.openInBrowser` vers l'URL platform avec query.
- Polling readiness toutes les 2-3s avec spinner, jusqu'à `ready` ou Ctrl-C.

5. Si non-interactif (`--json`, pas de TTY, `--no-prompt`) :
   - Exit avec error structuré : `{ code: "connections_missing", missing: [...], connectUrl: "..." }`.
6. Flag `--no-preflight` pour skip (utile en CI quand on sait que c'est ok).

**Critères de succès**

- Run d'un agent Gmail sans connexion : prompt → browser → user connecte → run continue automatiquement.
- En CI : exit 1 propre avec JSON parseable.

---

### [done] Phase 5 — Hardening + docs

1. Tests `bun:test` couvrant : résolution id, cache, héritage config, override per-provider, preflight (mock readiness).
2. Mise à jour `apps/cli/README.md` + section dédiée dans `docs/cli/`.
3. Migration guide pour les utilisateurs CI : flags qui changent de défaut, comment opter en/out.
4. `appstrate doctor` détecte une config CLI ↔ serveur incohérente (profil pinné qui n'existe plus, etc.).

## Décisions à figer avant exécution

| #      | Décision                                          | Pistes                                                                                                                                             |
| ------ | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1     | Vocabulaire `--profile` vs `--connection-profile` | Garder l'existant, alias `--cp`. Risque de confusion documentaire.                                                                                 |
| D2     | Page browser handoff                              | (a) `/agents/{scope}/{name}` existant (b) `/preferences/connectors?profile=&highlight=` (c) page dédiée `/connect`. Recommandé : (b) pour Phase 5. |
| D3     | `run-config` endpoint vs flags multiples          | Endpoint unique recommandé (source de vérité partagée UI ↔ CLI).                                                                                   |
| ~~D4~~ | ~~Bundle aplati côté serveur ou CLI~~             | Tranché — `GET /api/agents/{scope}/{name}/bundle` existe déjà.                                                                                     |
| D5     | Sémantique `--connection-profile default`         | Distinguer "rien envoyer" (cascade serveur) vs "force `isDefault=true`" (court-circuite override agent). À implémenter si besoin réel apparaît.    |
| D6     | Cache bundles partagé entre auth-profiles         | Oui si l'intégrité matche, mais clé incluant l'instance (`~/.cache/appstrate/bundles/{instanceHost}/...`) pour éviter cross-instance leakage.      |

## Dépendances entre phases

```
P1 (run id + bundle aplati) — indépendant
P2 (run-config héritée) — indépendant, bénéficie de P1
P3 (connection profiles) — indépendant
 └─→ P4 (preflight) ← dépend aussi de P2 pour connaître requiredProviders
P5 (hardening) — final
```

Ordre d'exécution recommandé : **P1 → P2 → P3 → P4 → P5**.

## Risques / questions ouvertes

- **R1** — Le credential proxy actuel ne sait peut-être pas sélectionner un profil. Bloquant pour P4 en mode local. À auditer en début de P4.
- **R2** — `application_packages.config` n'existe peut-être que pour les agents installés dans une appli ; un agent système non installé n'a rien à hériter. Comportement attendu : `run-config` retourne 404, le CLI fallback sur les flags / valeurs par défaut.
- **R3** — Le polling readiness en boucle peut frapper le rate limit. Espacer (2-3s minimum) et timeout au bout de 5 min.
- **R4** — Sécurité du cache bundle : un user A ne doit jamais réutiliser le bundle d'un user B sur la même machine. Inclure `userId` (ou hash du token) dans le chemin du cache si l'instance n'est pas suffisante.
- **R5** — Le mode `--providers=none` (no platform) doit continuer à marcher avec `appstrate run ./local.afps`. Ne pas casser.
