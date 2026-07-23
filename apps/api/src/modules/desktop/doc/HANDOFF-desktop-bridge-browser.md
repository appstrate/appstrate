# Handoff — Pont desktop / browser Appstrate

Reprise dans une autre conversation. État au 2026-07-23. Branche **`feat/desktop-bridge`** (worktree `worktrees/desktop-bridge`), instance de test **3100** (profil CLI `anon3100`, org TRACTR `23418a66`, app `app_6bc16f98`). L'app desktop Electron pointe sur 3100 (profil `bridge-3100`), port de debug CDP **9222**.

---

## 1. LIVRÉ (code committé + poussé sur `feat/desktop-bridge`)

### Saisie native (commit `8793fe66`)

`browser.click` / `browser.fill` réécrits en **CDP natif** (`Input.dispatchMouseEvent`, `DOM.focus`+select-all+`Input.insertText`) → événements `isTrusted:true` au lieu de l'injection JS (`el.click()`/value-setter, `isTrusted:false`). C'était le tell détecté par les anti-bots. Ajout **`browser.selectOption`** (`<select>` natif ; garde-fou not-a-select). Injection JS supprimée de `browser-api.ts` (reste `waitForSelector`, gardé en `executeJavaScript` exprès : lecture seule, pas d'attach debugger = empreinte anti-bot plus faible qu'une version CDP).

- 3 endroits synchronisés pour toute nouvelle méthode : `apps/desktop/src/bridge/client.ts` (handler), `apps/api/src/modules/desktop/routes.ts` (enum `desktopCommandSchema` + `BATCHABLE_METHODS`) + `openapi/schemas.ts`, `packages/runner-pi/src/runtime-tools/desktop-browser/tool.ts` (schéma tool sidecar, **compilé dans l'image `appstrate-sidecar`** → `bun run build-sidecar` + restart 3100 requis pour l'exposer).
- Types frontend régénérés (commit `8179dd7a`, `bun run generate:api`).

### Window handler (commit `a616db20`)

`setWindowOpenHandler` sur le panneau navigateur (`main.ts`) : les liens `target="_blank"` / `window.open` **restent dans le panneau piloté** (deny popup + `loadURL`) au lieu de créer une fenêtre native détachée que le pont ne pilote pas. Indispensable pour les logins qui s'ouvrent en popup (RQ gov, la plupart des OAuth par redirection).

### Doc (commit `ebb805ef`)

`doc/concepts-nouveaux.md` : le credential éphémère run-scoped + la chaîne de sécurité (substitution allowlist + scrubbing + capture liée aux `authorized_uris` + garde CSWSH).

---

## 2. PROUVÉ / EXPLORÉ (tests, pas du code repo — packages sur 3100)

### Généricité de l'archi credentials — 3 sites d'annonces

Login à identifiants cachés (substitution serveur, agent aveugle) prouvé sur **LesPAC, Craigslist, Kijiji** (packages `@tractr/{lespac,craigslist,kijiji}` + agents login sur 3100).

- **Insight anti-bot majeur** : DataDome/Cloudflare gardent la **navigation** (chargement de page), pas la **frappe** dans un champ déjà rendu. Hybride qui marche : navigation organique (humain ou Claude via CDP), puis remplissage programmatique en aveugle.
- **chrome-devtools MCP vs Electron** : sur Revenu Québec (Cloudflare), le Chrome du chrome-devtools MCP (`navigator.webdriver=true`, CDP permanent) est **bloqué** ; le browser Electron de l'app **passe** (même IP). C'est l'empreinte du navigateur qui compte.

### Automatisation Revenu Québec entreprise (gros morceau)

Voir mémoire projet `appstrate-rq-entreprise-automation`. Packages sur 3100 (sources scratchpad `classifieds/rq-entreprise-*`) :

- `@tractr/rq-entreprise` (intégration `custom` : `identifiant`+`mot_de_passe`).
- `@tractr/rq-entreprise-web` v1.3.0 (skill) : login figé clicSÉQUR express (formulaire ASP.NET `AuthUtilisateur`, `batches/login.json`) + recette récupération communications + §6 données structurées + dossier **`scripts/`** (bulk opérateur CDP, paiements-export, boucle in-page + README).
- `@tractr/rq-entreprise-login` v1.1.0 (connexion seule).
- `@tractr/rq-entreprise-sync` v1.3.0 (archive communications → Drive, idempotent par hash).
- **Login validé** : entrée organique revenuquebec.ca/entreprises → clicSÉQUR express (SAML → `services.mrq.gouv.qc.ca/AUTHLM/IdentificationUtilisateur.aspx`, Cloudflare franchi) → fill `#AuthUtilisateur1_...txtCodeUtils`/`txtMotPasse` → **2FA code courriel** lu dans Gmail (`@appstrate/gmail` api_call, `from:nepasrepondre@revenuquebec.ca`, regex `code de vérification est le suivant\s*:\s*(\d{6,8})`, arrive chez olivier@tractr.net) → dashboard.
- **Découverte clé** : documents ET messages = le même objet = PDF du **Centre de communications** `SX00A02`. Deux endpoints (à réémettre depuis la session du browser, Cloudflare bloque un client HTTP externe) : liste `AfficherListeCommunicationsEntreprise?PageSize=300&SortBy=Date` (fragment HTML, hash via `OuvrirCommunicationPdf\/([a-f0-9]+)`) + PDF `OuvrirCommunicationPdf/{hash}`.
- **Archive livrée** : **90 PDF** (2018→2026, 21 Mo) sur Drive `__Automations/Revenu Québec entreprise/Communications/` (nomenclature `AAAA-MM-JJ_dossier_objet.pdf`, **sans hash8** — voir §4). Backfill fait EN DIRECT via CDP opérateur (`/tmp/rq-bulk2.js`, `/tmp/rq-recon.js`).
- **+1 attestation** (`SX00J604`) dans `Attestations/`. Passe de vérif : RL-1 (logiciel externe, rien dans le portail), avis d'opposition (vide), contrats (NA), fichiers de taxes (action) → rien d'autre à fetch.
- **Données structurées → Drive `Données/`** (HTML scrapé, pas d'API JSON) : `paiements.csv` (132 paiements consolidés 2016→2026, endpoint `SX00N02/ConsulterPaiementsEntreprise/<route>`, table consolidée, un fetch, libellés collés à retirer) ; `releve-de-compte.json` (soldes courants tous 0). Déclarations/remboursements = recettes draftées dans skill §6, à confirmer.
- Carte complète du portail : `scratchpad/rq-entreprise-map.md` (sous-agent Opus `rq-mapper`).

### Diagnostic « pourquoi l'agent ne récupère pas les 90 en un run »

Longue investigation, conclusions **mesurées** :

- Test `@tractr/bulk-upload-test` : un agent boucle **200 `api_upload`** sans problème → « le LLM ne peut pas boucler » = **FAUX**.
- Le sous-débit du sync RQ (2-13/run) = **bug de dédup dans le prompt** (il croyait tout présent). **Corrigé** par idempotence + nommage **par hash8**. Re-runs additifs prouvés : 0→10→49→90, puis no-op.
- Le plafond « ~quelques dizaines par run » du sync RQ vient du **budget agentique cumulé** du workflow lourd (download+upload interleaved via le pont), PAS du retour de liste. Un prompt « léger » (retours minimaux) a été testé → **n'a rien débloqué** (toujours ~13) et a régressé le listing. Donc leanness/`toFile` ≠ le levier.

---

## 3. ARCHITECTURE — murs à connaître (le cœur du raisonnement)

Le sandbox de l'agent est **muré des deux côtés**, par conception :

- **Browser** : l'agent n'atteint le Chromium que par l'outil `desktop_browser` (MCP, piloté LLM), PAS par CDP direct. `browser.evaluate` = CDP `Runtime.evaluate` standard (comme Playwright), **sans credentials** (utilise la session/cookies du browser). Le download depuis un site connecté ne coûte donc AUCUN credential.
- **Credentials** : les jetons (Drive…) vivent dans le sidecar (credential-proxy). `SIDECAR_URL` est **effacé** de l'env agent après bootstrap (`runtime-pi/entrypoint.ts:698`, commentaire explicite) pour que `bash` ne puisse pas joindre le sidecar. Seule porte crédentialée = les tools MCP `api_call`/`api_upload` (un appel LLM par action).
- **Le sidecar ne peut PAS écrire dans le workspace** (`mcp.ts:1331` : `desktop_download` est agent-side pour ça, « mirrors api_upload »). Donc un `toFile` sur `browser.evaluate` devrait être géré **agent-side**, pas dans le handler sidecar → pas un simple calque d'`api_call`.
- Conséquence : une **boucle déterministe** dans le sandbox est impossible (ni browser ni creds accessibles à `bash`). Les scripts opérateur (`scripts/` du skill, `/tmp/rq-*.js`) tournent sur le Mac (CDP 9222 + mount Drive), HORS agent. Pour du bulk fiable DÉCLENCHÉ par l'agent, la boucle doit vivre dans du **code de confiance** = une primitive (voir §5).

Contraste **moi (Claude Code opérateur)** vs **agent** : je tourne sur le Mac non sandboxé (CDP 9222 direct + mount Drive local + `gog`), donc mes scripts font tout ; l'agent est isolé et passe par les tools MCP.

---

## 4. À FAIRE / EN SUSPENS

- **Réconcilier les noms de la vraie archive** : `Communications/` (90 PDF) est nommé SANS `_hash8`, mais le sync v1.3.0 reconnaît les présents PAR `_hash8`. Donc relancer le sync sur ce dossier re-téléchargerait tout. Fix : renommer les 90 existants pour ajouter `_hash8` (script opérateur matchant la liste live), OU repartir sur dossier vide.
- **RQ citoyen** (SAG Keycloak `authentification.quebec.ca`, realm `sqin`, client `RQ_MDC`) : package séparé PAS fait. Le login citoyen est OIDC/Keycloak (username/password) avec 2FA niveau-assurance-2 ; formulaire `#username`/`#password` derrière un bandeau cookies « J'accepte ».
- **Deep link `appstrate://` + lancement à la connexion du Mac** : identifié depuis longtemps, jamais construit (l'app desktop ne s'ouvre pas toute seule si fermée).
- **Ouvrir la PR upstream** de `feat/desktop-bridge` (branche poussée, PR non ouverte).
- Skill §6 (déclarations/remboursements structurés) : recettes draftées, sélecteurs à confirmer en direct.

## 5. ABANDONNÉ / DÉCIDÉ DE NE PAS FAIRE (avec raison)

- **`responseMode:{toFile}` sur `browser.evaluate`** : envisagé pour sortir la liste du contexte. **Abandonné** après mesure : (a) ça n'aurait pas débloqué le 90-en-un-run (le levier n'était pas là) ; (b) pas un simple calque d'`api_call` car le sidecar ne peut pas écrire le workspace (faudrait de l'agent-side). Les gros résultats (>256 Ko) débordent DÉJÀ en `resource_link`. KDY : on a mesuré avant de coder, et on n'a pas codé.
- **Primitive `bulk-download-vers-workspace` / `api_upload`-en-liste** : c'EST la seule vraie solution pour un bulk one-shot fiable à l'échelle DÉCLENCHÉ par l'agent (boucle dans du code de confiance : `browser.download_batch` côté pont + upload en lot côté sidecar). **NON construite** — jugée optionnelle car les **re-runs additifs idempotents suffisent** pour l'usage réel (incrémental + backfill en 2-3 passes). À reprendre si un vrai besoin one-shot-à-l'échelle émerge. Ne PAS l'implémenter en surchargeant `api_upload` (casse l'invariant « 1 tool = 1 requête HTTP » du credential-proxy) ; tool frère dédié, ou download qui dépose directement vers la destination.
- **Redis fan-out multi-replica** et **signature/notarisation de l'app** : explicitement hors scope (dit par Olivier : « on fait pas redi et signature »).

## 6. OPÉRATIONNEL

- **Segfault Bun intermittent** du sidecar (« Runner stopped reporting — no heartbeat for 60s ») frappe ~1 run sur 2 AVANT toute action ; **retry suffit** systématiquement. Pas nos packages.
- « `@tractr/X: api_call exposed 0 tools` » est NORMAL pour un agent qui n'utilise pas `api_call` sur cette intégration (login-demo).
- Sessions RQ **expirent vite** (ASP.NET/ADFS) → redirection login. Re-login : `appstrate -p anon3100 run @tractr/rq-entreprise-login --remote` (retry si segfault). Toujours **valider qu'on est sur la bonne page avant de scraper** (sinon on ramasse la page de login — bug rencontré 2×).
- Helpers CDP opérateur dans `/tmp` : `rq-eval.js` (eval one-shot, WS dans `/tmp/rq-pane-ws.txt`), `rq-netlog.js` (logger réseau → `/tmp/rq-net.jsonl`), `rq-bulk2.js`/`rq-recon.js` (backfill PDF), `cdp-drive.js`/`cdp-inspect.js` (navigation directe). Re-dériver la cible : `curl -s localhost:9222/json | python3 -c "...filter entreprises.revenuquebec..." > /tmp/rq-pane-ws.txt`.
- Google Drive + Gmail connectés + actifs sur 3100 (org TRACTR). Le **mount Drive local** (`~/Library/CloudStorage/GoogleDrive-olivier@tractr.net/Mon disque/`) synchronise ce qu'on y écrit → utile pour les backfills opérateur.
- Mémoires liées : `[[appstrate-desktop-bridge]]`, `[[appstrate-desktop-bridge-classifieds-test]]`, `[[appstrate-rq-entreprise-automation]]`.
