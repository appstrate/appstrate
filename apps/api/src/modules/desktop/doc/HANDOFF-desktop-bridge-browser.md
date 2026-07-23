# Handoff du pont desktop et browser

État consolidé au 2026-07-23 sur `feat/desktop-bridge`.

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
    "authorized_uris": ["https://portal.example.com/**"]
  }
}
```

`browser.evaluate` demande en plus `desktop_browser_evaluate`. Cette capacité
est volontairement séparée car elle exécute du JavaScript arbitraire dans une
session utilisateur.

Sans `desktop_browser`, le sidecar ne publie aucun outil desktop et le launcher
peut conserver son chemin sans sidecar.

## Architecture actuelle

1. L'app Electron charge le SPA et le browser agent dans deux partitions
   persistantes distinctes.
2. Le bridge natif se connecte à
   `/api/desktop/bridge?protocol=1` avec la session du panneau SPA.
3. Le sidecar appelle `/internal/desktop-command` avec le token du run.
4. L'API vérifie la capacité, les URI, le propriétaire et le bail exclusif du
   browser.
5. La commande JSON-RPC est exécutée séquentiellement sur le panneau browser.
6. La réponse revient au run, avec scrubbing des valeurs sensibles en défense
   additionnelle.

Le registre, le bail, les credentials éphémères, les secrets de scrubbing et
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
- Un seul run contrôle le browser d'un utilisateur. Un second run reçoit 409.
- Le browser est remis sur `about:blank` lors d'un changement de propriétaire.
- Chaque commande agent transporte les `authorized_uris`. Le desktop vérifie
  la page ou la cible et bloque les navigations principales hors périmètre.
- La substitution de credentials est limitée à `browser.fill`.
- Un même run ne peut pas combiner substitution ou capture de credentials avec
  `browser.evaluate`, quel que soit l'ordre.
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

## Nettoyage de fin de run

Sur `success`, `failed`, `timeout` ou `cancelled`, le module libère:

- le bail desktop;
- le cache de politique du manifeste;
- les secrets de scrubbing;
- les credentials éphémères;
- les fichiers et records de téléchargement du run.

Un TTL reste présent pour couvrir un crash ou un événement terminal manquant.

## Fichiers de référence

- `apps/api/src/modules/desktop/routes.ts`
- `apps/api/src/modules/desktop/lease.ts`
- `apps/api/src/modules/desktop/registry.ts`
- `apps/api/src/modules/desktop/downloads.ts`
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
