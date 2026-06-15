# @appstrate/module-chat

Module Appstrate — chat conversationnel first-party au-dessus de la plateforme.

**Opt-in** : ajouter `@appstrate/module-chat` à `MODULES` pour l'activer. Désactivé = zéro empreinte (pas de routes, pas de flag, pas de RBAC ; les tables `chat_sessions`/`chat_messages` vivent dans le schéma core et restent inertes).

## Surfaces

| Surface        | Contenu                                                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.` (backend)  | `AppstrateModule` : routes `/api/chat/*`, RBAC `chat:read/write`, flag `features.chat`, contribution OpenAPI (→ auto-exposé en MCP via le module `mcp`) |
| `./ui` (front) | `ChatPanel` (composant embarquable, prop `context` injectable) + `ChatPage` (wrapper plein écran lazy-loadé par le shell derrière `features.chat`)      |

## Composant-d'abord (combinabilité)

`ChatPanel` est conçu pour être monté **dans** d'autres modules (ex. le panneau latéral du module documents/workspace) :

```tsx
import { ChatPanel } from "@appstrate/module-chat/ui";

<ChatPanel context={{ type: "document", id: openFileId, label: title }} getHeaders={orgHeaders} />;
```

Discipline d'embarquabilité : pas de store global, pas de navigation interne, thème par tokens hérités, accès API par fetch + headers injectés.

## Cerveau LLM (✅ transplanté du satellite appstrate-chat)

`POST /api/chat` = boucle AI SDK v6 `streamText` (UIMessage stream) :

- **Modèles** : résolus via `GET /api/models` de l'org, inference via le **llm-proxy** de la plateforme (clé injectée côté serveur, métrée) — le module ne détient aucune clé.
- **Outils** : les méta-tools du module `mcp` (`search/describe/invoke_operation`) + `wait_for_run` (poll bloquant en un step) — le modèle pilote la plateforme avec les permissions de l'appelant.
- **Identité** : forward des headers de l'appelant (cookie/Authorization + X-Org-Id/X-Application-Id) sur appels loopback — l'OAuth audience-bindé du satellite disparaît, le pipeline d'auth ré-authentifie chaque saut.
- **Persistance** : chaque tour est écrit dans `chat_sessions`/`chat_messages` ; le client épingle la session via le header `X-Chat-Session-Id`.
- **Front** : assistant-ui (`useChatRuntime` + `AssistantChatTransport`), thread porté du satellite (markdown, cartes de tools, branching, édition/régénération).

## Reste à faire

- **Liste de sessions dans l'UI** (`GET /api/chat/sessions` existe) + restauration d'un thread persisté ; citations numérotées (idée Onyx).
- **Sélecteur de modèle** dans `ChatPanel` (le header `X-Model-Id` est déjà câblé côté serveur).
- **Rate limiting** : `rateLimit()`/`idempotency()` sont internes à apps/api — à exporter pour les modules npm.
- **End-users** : flip `endUserGrantable` quand le chat embarqué B2B2C arrive.
