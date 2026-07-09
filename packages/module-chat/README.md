# @appstrate/module-chat

Module Appstrate — chat conversationnel first-party au-dessus de la plateforme.

**Opt-in** : ajouter `@appstrate/module-chat` à `MODULES` pour l'activer. Désactivé = zéro empreinte (pas de routes, pas de flag, pas de RBAC ; les tables `chat_sessions`/`chat_messages` vivent dans le schéma core et restent inertes).

## Surfaces

| Surface        | Contenu                                                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.` (backend)  | `AppstrateModule` : routes `/api/chat/*`, RBAC `chat:read/write`, flag `features.chat`, contribution OpenAPI (→ auto-exposé en MCP via le module `mcp`) |
| `./ui` (front) | `ChatPage` (plein écran, lazy-loadé par le shell derrière `features.chat` ; liste de sessions + thread)                                                 |

## Cerveau LLM (✅ transplanté du satellite appstrate-chat)

`POST /api/chat` = boucle AI SDK v6 `streamText` (UIMessage stream) :

- **Modèles** : résolus via `GET /api/models` de l'org, inference via le **llm-proxy** de la plateforme (clé injectée côté serveur, métrée) — le module ne détient aucune clé.
- **Subscription** : les modèles oauth-subscription (ex. claude-code) sont servis par le moteur Pi in-process générique du module (`src/pi-chat/`), résolu via les services plateforme (`resolveSubscriptionChatModel`) — pas de seam par fournisseur, pas de binaire externe ; pi-ai émet nativement le request shape subscription du fournisseur depuis le token.
- **Outils** : les méta-tools du module `mcp` (`search_operations` / `describe_operation` / `invoke_operation`) exposés via le MCP HTTP de la plateforme — le modèle pilote la plateforme avec les permissions de l'appelant.
- **Identité** : forward des headers de l'appelant (cookie/Authorization + X-Org-Id/X-Application-Id) sur appels loopback — l'OAuth audience-bindé du satellite disparaît, le pipeline d'auth ré-authentifie chaque saut.
- **Persistance** : chaque tour est écrit dans `chat_sessions`/`chat_messages` ; la session est identifiée par un id de chemin (`/api/chat/sessions/:id/messages`), créé côté serveur — pas de header dédié.
- **Front** : assistant-ui (`useChatRuntime` + `AssistantChatTransport`), thread porté du satellite (markdown, cartes de tools, branching, édition/régénération), liste de sessions (`thread-list`) et sélecteur de modèle (`model-select`).

## Limitations connues (hors périmètre)

Le module est fonctionnel et autonome ; les points ci-dessous sont des extensions
volontairement hors périmètre, documentées pour les intégrateurs — pas du code
inachevé.

- **Citations numérotées** : non encore proposées dans l'UI.
- **Rate limiting** : `rateLimit()`/`idempotency()` sont internes à apps/api ; un module npm ne peut pas encore les appliquer tant qu'ils ne sont pas exportés.
- **End-users** : `endUserGrantable` reste désactivé jusqu'à l'arrivée du chat embarqué B2B2C.

### Écarts de parité entre moteurs (ai-sdk vs subscription)

Le moteur `ai-sdk` intercepte chaque tool result avant le modèle ; le moteur
subscription (le moteur Pi in-process, `src/pi-chat/`) exécute sa boucle
d'outils en interne, sans hook équivalent. Une protection est donc
**ai-sdk uniquement** :

- **Redaction des liens de connexion** (`redactConnectLinks`, `platform-mcp.ts`) :
  côté subscription, le modèle voit le `connect_url` brut dans le tool result —
  seule l'instruction du serveur MCP (« ne jamais coller le lien ») le retient.
  Une redaction serveur casserait le bouton de connexion : l'UI extrait l'offre
  du même tool result (`extract-auth-offer`).
- **Politique d'index d'opérations** (`applyOperationIndexPolicy`) : couverte
  des deux côtés — le moteur Pi la reflète localement
  (`dropOperationIndexForUncached`, `src/pi-chat/engine.ts`).

## Configuration (variables d'environnement)

Ces variables sont lues directement par le module (pas via le schéma Zod
`@appstrate/env`), toutes optionnelles :

| Variable           | Défaut                   | Rôle                                                                                                                                                                                                        |
| ------------------ | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHAT_SELF_ORIGIN` | `http://127.0.0.1:$PORT` | Origine loopback pour les appels in-process (`/api/models`, `/api/llm-proxy`, `/api/mcp`). **Doit rester loopback** : ce hop transmet le cookie/Authorization de l'appelant (rejeté sinon — cf. `self.ts`). |
| `CHAT_DEBUG`       | _(absent)_               | Si défini, active les logs de debug verbeux du module.                                                                                                                                                      |
