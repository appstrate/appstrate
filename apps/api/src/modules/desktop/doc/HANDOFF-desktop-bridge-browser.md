# Handoff du pont desktop et browser

État consolidé au 2026-07-24 sur `feat/desktop-bridge`.

> Le pont est passé au **protocole 2 (multi-onglets)**. Ce document décrit
> le contrat courant. La conception détaillée est dans
> `SPEC-multi-onglets.md`.

Ce document décrit le contrat actuel du code. Les expériences RQ, LesPAC,
Craigslist et Kijiji ont servi à valider l'approche, mais leurs packages et
scripts opérateur ne constituent pas le contrat du bridge.

## Contrat produit

Le module API reste expérimental et opt-in via `MODULES`. Chaque agent doit
aussi déclarer sa capacité:

```json
{
  "runtime_tools": ["desktop_browser"],
  "desktop_browser": {
    "authorized_uris": ["https://portal.example.com/**"],
    "session": "agent"
  }
}
```

`session` choisit le profil de navigation et vaut `agent` par défaut:

- `agent`: un profil persistant par agent. Les sessions ouvertes sont
  réutilisées d'un run à l'autre du même agent et restent illisibles pour
  tout autre agent.
- `isolated`: un profil jetable par run.
- `user`: le profil du navigateur de la personne. À déclarer
  explicitement, pour les logins qui ne peuvent pas être automatisés.

`browser.evaluate` demande en plus `desktop_browser_evaluate`. Cette capacité
est volontairement séparée car elle exécute du JavaScript arbitraire dans une
session utilisateur.

Sans `desktop_browser`, le sidecar ne publie aucun outil desktop et le launcher
peut conserver son chemin sans sidecar.

## Architecture actuelle

1. L'app Electron charge le SPA dans sa propre partition et héberge N
   onglets, chacun lié à la partition de son propriétaire.
2. Le bridge natif se connecte à `/api/desktop/bridge?protocol=2` avec la
   session du panneau SPA. Le protocole 1 reste accepté.
3. Le sidecar appelle `/internal/desktop-command` avec le token du run.
4. L'API vérifie la capacité, les URI, le propriétaire, le bail de
   l'onglet et le bail d'origine. Si le run n'a pas encore d'onglet, elle
   en ouvre un dans la partition dictée par le manifeste.
5. La commande JSON-RPC est exécutée sur cet onglet. Les commandes d'un
   même onglet sont sérialisées, deux onglets progressent en parallèle.
6. La réponse revient au run, avec scrubbing des valeurs sensibles en défense
   additionnelle.

Le registre, les baux, les credentials éphémères, les secrets de scrubbing et
les téléchargements restent en mémoire dans le processus API.

## Invariants de sécurité

- La session Better Auth du SPA n'est pas présente dans le browser agent.
- Le CDP distant est désactivé en production. En développement, il faut
  explicitement définir `APPSTRATE_DESKTOP_REMOTE_DEBUG=1`.
- Les permissions Electron sont refusées par défaut.
- HTTP est accepté uniquement sur loopback. Une instance distante doit être
  en HTTPS.
- Le WebSocket vérifie l'origine, la version du protocole et la taille des
  frames.
- Une déconnexion rejette immédiatement les commandes en attente.
- Un onglet appartient à un run ou à la personne, et n'est jamais
  transféré. Un run ne pilote que ses onglets (409), le chemin manuel
  `/api/desktop/me/command` ne pilote que les onglets de la personne.
- Les onglets d'un run sont fermés à son statut terminal. Un profil
  `isolated` disparaît avec eux.
- Deux runs qui partagent réellement un profil (même agent, ou
  `session: "user"`) sont sérialisés par origine: le second reçoit 409
  tant que le premier travaille sur ce site.
- Une reprise en main humaine met l'onglet en pause: les commandes agent
  reçoivent 409 jusqu'à ce que la personne rende la main. Une fermeture
  donne 410.
- Chaque onglet porte ses propres `authorized_uris`, figées à son
  ouverture. Le desktop vérifie la page ou la cible et bloque les
  navigations principales hors périmètre. Une popup hérite du
  propriétaire et du périmètre de l'onglet ouvrant.
- Un téléchargement n'est corrélé qu'à l'intérieur de l'onglet qui l'a
  commandé.
- Quotas: 3 onglets par run, 8 par utilisateur.
- La substitution de credentials est limitée à `browser.fill`.
- Substitution (ou capture) et `browser.evaluate` ne peuvent pas coexister
  dans une même **partition**, quel que soit l'ordre et quel que soit le
  run qui les demande. La règle était par run en v1, où le bail global
  l'imposait implicitement; deux runs concurrents pouvaient sinon se
  partager la paire.
- `browser.capture_credential` accepte uniquement des sources déclaratives:
  cookie, `localStorage`, `sessionStorage`, avec chemin JSON optionnel.
- La capture vérifie l'intégration déclarée, l'auth exacte, ses
  `authorized_uris`, les champs de `credentials.schema` et les limites de
  taille.
- Les credentials capturés restent éphémères et sont supprimés au statut
  terminal du run.

## Téléchargements

`browser.download` propose deux formes:

- une URL directe déjà autorisée;
- un `selector`, enregistré puis cliqué par la même commande.

L'ancien `capture: true`, qui laissait une fenêtre FIFO ouverte pour le
prochain téléchargement, est supprimé. La corrélation expire après dix
secondes. Les transitions terminales sont immuables, la taille et le SHA-256
annoncés sont validés, le flux servi au run reste borné.

Les octets passent par le storage en HTTPS, jamais par le WebSocket.

## Limites connues et assumées

- **Deux runs du même agent partagent son profil.** Ils ont le même
  périmètre d'autorisations et les mêmes intégrations déclarées, donc le
  partage n'accorde rien qu'un run n'ait déjà. Le bail d'origine les
  empêche d'être simultanément sur le même site.
- **`session: "user"` reste un prêt de session.** L'agent hérite des
  connexions de la personne et lui en laisse. C'est désormais une ligne
  de manifeste visible et refusable, plus le comportement par défaut.
- La reprise en main automatique se déclenche à la frappe clavier et au
  pilotage depuis la barre locale, pas au simple clic souris (Electron
  n'expose pas d'événement main-process équivalent). Le bouton de pause
  de la barre d'onglets couvre le reste.
- Multi-réplique toujours hors scope: registre et baux sont en mémoire.

## Nettoyage de fin de run

Sur `success`, `failed`, `timeout` ou `cancelled`, le module libère:

- les onglets du run (fermés côté desktop) et leurs baux d'origine;
- le cache de politique du manifeste;
- les secrets de scrubbing;
- les credentials éphémères;
- les fichiers et records de téléchargement du run.

Un TTL reste présent pour couvrir un crash ou un événement terminal manquant.

## Fichiers de référence

- `apps/api/src/modules/desktop/doc/SPEC-multi-onglets.md`
- `apps/api/src/modules/desktop/routes.ts`
- `apps/api/src/modules/desktop/lease.ts`
- `apps/api/src/modules/desktop/registry.ts`
- `apps/api/src/modules/desktop/downloads.ts`
- `apps/desktop/src/tabs.ts`
- `apps/desktop/src/main.ts`
- `apps/desktop/src/bridge/client.ts`
- `apps/desktop/src/bridge/downloads.ts`
- `packages/runner-pi/src/runtime-tools/desktop-browser/tool.ts`

Le README du module contient le résumé opérationnel. `concepts-nouveaux.md`
reste une note historique et ne doit pas remplacer le contrat ci-dessus.

## Hors scope confirmé

- Redis et fan-out multi-réplique;
- signature et notarisation;
- primitive bulk;
- deep link;
- lancement automatique à la connexion;
- support Windows et Linux.
