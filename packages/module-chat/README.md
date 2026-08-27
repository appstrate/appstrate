# @appstrate/module-chat

Module Appstrate — chat conversationnel first-party au-dessus de la plateforme.

**Opt-in** : ajouter `@appstrate/module-chat` à `MODULES` pour l'activer. Désactivé = zéro empreinte (pas de routes, pas de flag, pas de RBAC ; les tables `chat_sessions`/`chat_messages` vivent dans le schéma core et restent inertes).

## Surfaces

| Surface        | Contenu                                                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.` (backend)  | `AppstrateModule` : routes `/api/chat/*`, RBAC `chat:read/write`, flag `features.chat`, contribution OpenAPI (→ auto-exposé en MCP via le module `mcp`) |
| `./ui` (front) | `ChatPage` (plein écran, lazy-loadé par le shell derrière `features.chat` ; liste de sessions + thread)                                                 |

## Cerveau LLM (✅ transplanté du satellite appstrate-chat)

`POST /api/chat` = une seule boucle Pi in-process, qui émet un UIMessage stream
AI SDK comme protocole de fil (c'est le contrat que consomme assistant-ui) :

- **Modèles** : résolus via `GET /api/models` de l'org, inference via le **llm-proxy** de la plateforme (clé injectée côté serveur, métrée) — le module ne détient aucune clé.
- **Moteur** : TOUS les modèles sont servis par le moteur Pi in-process générique du module (`src/pi-chat/`) — pas de seam par fournisseur, pas de second moteur, pas de binaire externe. Le mode de credential est résolu via les services plateforme (`resolveChatModel`) : un modèle oauth-subscription (ex. claude-code) donne à Pi le vrai token et le baseUrl du fournisseur, et pi-ai en émet nativement le request shape ; un modèle par clé API donne à Pi une clé inerte et une base URL llm-proxy, le vrai secret ne quittant jamais la plateforme.
- **Outils** : les méta-tools du module `mcp` (`search_operations` / `describe_operation` / `invoke_operation`) exposés via le MCP HTTP de la plateforme — le modèle pilote la plateforme avec les permissions de l'appelant.
- **Identité** : forward des headers de l'appelant (cookie/Authorization + X-Org-Id/X-Space-Id) sur appels loopback — l'OAuth audience-bindé du satellite disparaît, le pipeline d'auth ré-authentifie chaque saut.
- **Persistance** : **autoritative côté serveur**. `POST /api/chat` est l'unique écrivain de messages : il écrit le tour utilisateur AVANT l'inférence et le tour assistant quand le flux se finalise (`src/persistence.ts`), le drain de persistance tournant indépendamment de la connexion client (`src/finalize-stream.ts`) — quitter la conversation en pleine génération ne perd plus rien. Il n'existe **aucune route d'écriture de message côté client** : les routes `/api/chat/sessions/*` ne font que du CRUD de session et de la LECTURE d'historique. La session est identifiée par l'id que le client frappe (`mintSessionId`) et transmet dans le corps de `POST /api/chat` ; la ligne est créée à la volée (`ensureSession`) — pas de header dédié.
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
  endroit : le champ typé `connectOffer`, que la carte de connexion lit via
  `readConnectOffer` (`src/ui/auth-offer.ts`) — jamais en scrapant le payload,
  qui ne contient plus que le placeholder (issue #906). La redaction s'applique
  aussi au replay de l'historique persisté
  (`src/pi-chat/structured-session.ts`).
- **Politique d'index d'opérations** : `applyOperationIndexPolicy`
  (`src/operation-index.ts`), appliquée par le moteur au prompt système après
  y avoir ajouté les instructions MCP. Elle discrimine par **apiShape**, pas par
  moteur : l'index est retiré pour les fournisseurs sans cache de prompt.

## Configuration (variables d'environnement)

Ces variables sont lues directement par le module (pas via le schéma Zod
`@appstrate/env`), toutes optionnelles :

| Variable                  | Défaut                   | Rôle                                                                                                                                                                                                                             |
| ------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHAT_SELF_ORIGIN`        | `http://127.0.0.1:$PORT` | Origine loopback pour les appels in-process (`/api/models`, `/api/llm-proxy`, `/api/mcp`). **Doit rester loopback** : ce hop transmet le cookie/Authorization de l'appelant (rejeté sinon — cf. `self.ts`).                      |
| `CHAT_PI_MAX_CONCURRENCY` | `6`                      | Plafond de sessions de chat simultanées dans le process API. **Chaque** tour de chat réserve un slot ; à saturation la route répond 429. À fixer depuis une capacité mesurée avant de servir du trafic réel — cf. `docs/ENV.md`. |
