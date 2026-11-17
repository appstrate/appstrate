# @appstrate/module-chat

Module Appstrate — chat conversationnel first-party au-dessus de la plateforme.

**Opt-in** : ajouter `@appstrate/module-chat` à `MODULES` pour l'activer. Désactivé = zéro empreinte (pas de routes, pas de flag, pas de RBAC ; les tables `chat_sessions`/`chat_messages` vivent dans le schéma core et restent inertes).

## Surfaces

| Surface        | Contenu                                                                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.` (backend)  | `AppstrateModule` : routes `/api/orgs/:orgId/chat/*`, RBAC `chat:read/write`, flag `features.chat`, contribution OpenAPI (→ auto-exposé en MCP via le module `mcp`) |
| `./ui` (front) | `ChatPage` (plein écran, lazy-loadé par le shell derrière `features.chat` ; liste de sessions + thread)                                                             |

## Cerveau LLM (✅ transplanté du satellite appstrate-chat)

`POST /api/orgs/:orgId/chat` = une seule boucle Pi in-process, qui émet un UIMessage stream
AI SDK comme protocole de fil (c'est le contrat que consomme assistant-ui) :

- **Modèles** : résolus via `GET /api/models` de l'org, inference via le **llm-proxy** de la plateforme (clé injectée côté serveur, métrée) — le module ne détient aucune clé.
- **Moteur** : TOUS les modèles sont servis par le moteur Pi in-process générique du module (`src/pi-chat/`) — pas de seam par fournisseur, pas de second moteur, pas de binaire externe. Le mode de credential est résolu via les services plateforme (`resolveChatModel`) : un modèle oauth-subscription (ex. claude-code) donne à Pi le vrai token et le baseUrl du fournisseur, et pi-ai en émet nativement le request shape ; un modèle par clé API donne à Pi une clé inerte et une base URL llm-proxy, le vrai secret ne quittant jamais la plateforme.
- **Outils** : les méta-tools du module `mcp` (`search_operations` / `describe_operation` / `invoke_operation`) exposés via le MCP HTTP de l'organisation (`/api/mcp/o/:org`) — le modèle pilote la plateforme avec les permissions de l'appelant, chaque appel nommant son `space_id`.
- **Conversations** : un seul type. Une conversation appartient à l'organisation et à son auteur. Son **espace d'origine** (`chat_sessions.space_id`, nullable : l'espace sélectionné à la création, NULL depuis « Tous les espaces ») n'est pas un propriétaire : il donne les skills imposés, l'espace par défaut d'une demande sans espace (jamais un épinglage) et l'option **limiter à cet espace** (`restricted` : la conversation agit toujours par l'endpoint MCP de l'organisation, mais le bearer du tour n'autorise que cet espace). Une conversation sans espace d'origine le reçoit seulement en étant limitée : l'espace choisi devient son origine (`PATCH …/sessions/{id}` avec `spaceId` et `restricted: true`), et l'origine ne change plus ensuite. Sans espace d'origine, une demande sans espace va à l'espace personnel de l'appelant, sinon à l'espace par défaut de l'organisation, quand le tour y agit ; le modèle ne demande que si aucun ne l'est. Une conversation n'exécute qu'un tour à la fois : un second tour pendant qu'un premier est en cours est refusé (409 `chat_turn_in_flight`). Un fichier joint est envoyé dans l'espace que le chat nomme (`attachAvailability` : l'origine, sinon l'espace sélectionné, sinon l'unique espace d'action, sinon celui que l'utilisateur choisit), jamais dans l'espace de travail caché de « Tous les espaces ». Les espaces **touchés** (l'origine plus `chat_session_spaces`) sont un filtre (`GET …/sessions?spaceId=`) et la condition de visibilité (tous lisibles avec `chat:read`).
- **Identité** : les appels loopback portent un bearer frappé par le module — l'OAuth audience-bindé du satellite disparaît, le pipeline d'auth ré-authentifie chaque saut. Les bearers frappés par le module (`src/loopback-auth.ts`, secret process-local, un tour) déclarent `principalKind: "user"` : le loopback EST l'appelant par un autre transport, donc espaces personnels et grants par principal répondent au tour du moteur exactement comme à sa requête (cf. `docs/architecture/RBAC_PERMISSIONS_SPEC.md` §7.4).
- **Persistance** : **autoritative côté serveur**. `POST /api/orgs/:orgId/chat` est l'unique écrivain de messages : il écrit le tour utilisateur AVANT l'inférence et le tour assistant quand le flux se finalise (`src/persistence.ts`), le drain de persistance tournant indépendamment de la connexion client (`src/finalize-stream.ts`) — quitter la conversation en pleine génération ne perd plus rien. Il n'existe **aucune route d'écriture de message côté client** : les routes `/api/orgs/:orgId/chat/sessions/*` ne font que du CRUD de session et de la LECTURE d'historique. La session est identifiée par l'id que le client frappe (`mintSessionId`) et transmet dans le corps du tour ; la ligne est créée à la volée (`ensureSession`) — pas de header dédié.
- **Front** : assistant-ui (`useChat` + `DefaultChatTransport` d'AI SDK, enveloppés par `useAISDKRuntime`), thread porté du satellite (markdown, cartes de tools, branching, édition/régénération), liste de sessions (`thread-list`) et sélecteur de modèle (`model-select`). L'adaptateur d'historique est en LECTURE seule.

## Limitations connues (hors périmètre)

Le module est fonctionnel et autonome ; les points ci-dessous sont des extensions
volontairement hors périmètre, documentées pour les intégrateurs — pas du code
inachevé.

- **Citations numérotées** : non encore proposées dans l'UI.
- **Rate limiting** : `rateLimit()`/`idempotency()` sont internes à apps/api ; un module npm ne peut pas encore les appliquer tant qu'ils ne sont pas exportés.
- **End-users** : `endUserGrantable` reste désactivé jusqu'à l'arrivée du chat embarqué B2B2C.

### Protections côté modèle

- **Redaction des liens de connexion** : dans le forwarder Pi
  (`src/pi-chat/mcp-tools.ts`), les deux canaux de payload sont redactés — le
  canal `content` (seul sérialisé vers le modèle par pi-ai) comme `details`
  (vue JSON de l'UI, mais persistée). L'URL vivante ne survit qu'à un seul
  endroit : le champ typé `connectOffers`, que les cartes de connexion lisent
  via `readConnectOffers` (`src/connect-offer.ts`, exposé à l'UI par
  `extractAuthOffers` dans `src/ui/auth-offer.ts`) — jamais en scrapant le
  payload, qui ne contient plus que le placeholder. Un payload peut
  porter plusieurs liens — un 409 de lancement en liste un par intégration à
  connecter — et l'UI monte une carte par offre. La redaction s'applique
  aussi au replay de l'historique persisté
  (`src/pi-chat/structured-session.ts`).
- **Politique d'index d'opérations** : `applyOperationIndexPolicy`
  (`src/operation-index.ts`), appliquée par le moteur au prompt système après
  y avoir ajouté les instructions MCP. Elle discrimine par **apiShape**, pas par
  moteur : l'index est retiré pour les fournisseurs sans cache de prompt.

## Configuration (variables d'environnement)

Ces variables sont validées par le schéma Zod du module
(`src/env.ts`, pas par `@appstrate/env`) au démarrage — une valeur invalide
bloque le boot. Toutes optionnelles :

| Variable                  | Défaut                   | Rôle                                                                                                                                                                                                                             |
| ------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHAT_SELF_ORIGIN`        | `http://127.0.0.1:$PORT` | Origine loopback pour les appels in-process (`/api/models`, `/api/llm-proxy`, `/api/mcp`). **Doit rester loopback** : ce hop transmet le cookie/Authorization de l'appelant (rejeté sinon — cf. `self.ts`).                      |
| `CHAT_PI_MAX_CONCURRENCY` | `6`                      | Plafond de sessions de chat simultanées dans le process API. **Chaque** tour de chat réserve un slot ; à saturation la route répond 429. À fixer depuis une capacité mesurée avant de servir du trafic réel — cf. `docs/ENV.md`. |
