# Troubleshooting Appstrate

Guide de diagnostic et résolution des erreurs courantes lors de l'utilisation de l'API Appstrate. **Diagnostic autonome : toujours vérifier via l'API avant de demander quoi que ce soit à l'utilisateur.**

## Diagnostic rapide

Avant toute investigation, exécuter ces appels dans l'ordre :

1. **L'API est-elle accessible ?** → `GET {BASE_URL}/health` — doit retourner `{ "status": "healthy" }`
2. **L'authentification est-elle valide ?** → `GET {BASE_URL}/api/flows` — doit retourner 200
3. **Le flow existe-t-il ?** → `GET {BASE_URL}/api/flows/{packageId}` — doit retourner 200

Si l'étape 1 échoue, le serveur est down — rien d'autre ne fonctionnera.
Si l'étape 2 retourne 401, la clé API est invalide/expirée — demander une nouvelle clé à l'utilisateur.
Si l'étape 3 retourne 404, vérifier l'ID du flow via `GET /api/flows` (lister tous les flows disponibles).

---

## Erreurs d'authentification

### 401 Unauthorized — "Missing or invalid authentication"

**Diagnostic autonome :**
```
GET {BASE_URL}/api/flows
Authorization: Bearer ask_...
```

**Actions de l'agent :**
1. Vérifier le format du header : `Authorization: Bearer ask_<48 hex chars>`
2. Si l'appel échoue en 401, la clé est invalide, expirée ou révoquée
3. Informer l'utilisateur : « Votre clé API est invalide ou expirée. Créez-en une nouvelle dans Organization Settings > API Keys. »

### 403 Forbidden — "Insufficient permissions"

**Diagnostic autonome :**

La clé API est valide mais l'utilisateur n'a pas les droits admin. Les opérations en lecture fonctionneront toujours.

**Actions de l'agent :**
1. Déterminer si l'opération nécessite vraiment le rôle admin (création de flow, modification de provider, gestion de packages)
2. Si oui, informer l'utilisateur : « Cette opération nécessite le rôle admin. Vérifiez votre rôle dans Organization Settings. »
3. Si non, vérifier que l'appel est bien fait sur la bonne ressource

---

## Erreurs de création de flow

### 400 VALIDATION_ERROR — "metadata.id: Doit etre un slug valide"

**Cause :** L'ID du flow ne respecte pas le format kebab-case.

**Règles :**
- Caractères autorisés : `a-z`, `0-9`, `-`
- Ne peut pas commencer ni finir par un tiret
- Pas de majuscules, espaces, underscores, ou caractères spéciaux

**Exemples :**
- `my-flow` → valide
- `email-to-tickets` → valide
- `My_Flow` → invalide
- `-bad-start` → invalide

**Action de l'agent :** Corriger l'ID automatiquement (lowercase, remplacer les underscores/espaces par des tirets, supprimer les caractères invalides) et réessayer.

### 400 NAME_COLLISION — "Flow ID already exists"

**Diagnostic autonome :**
```
GET {BASE_URL}/api/flows
```

Chercher le flow existant avec cet ID dans la réponse.

**Actions de l'agent :**
1. Si l'objectif est de mettre à jour le flow existant → utiliser `PUT /api/flows/{packageId}` au lieu de `POST`
2. Si c'est un nouveau flow distinct → choisir un ID différent automatiquement (ex: `my-flow-v2`)

### 400 INVALID_MANIFEST — Erreurs de validation du manifest

**Erreurs fréquentes dans le manifest :**

| Erreur | Cause | Action de l'agent |
|--------|-------|----------|
| `metadata.id: Required` | Champ `id` manquant dans metadata | Ajouter `"id": "mon-flow"` dans metadata |
| `metadata.displayName: Required` | Pas de nom d'affichage | Ajouter `"displayName": "Mon Flow"` |
| `requires.providers: Required` | Section providers manquante | Ajouter `"providers": {}` même si vide |
| `input.schema.required: Expected array` | `required: true` sur une propriété | Corriger : utiliser `"required": ["field1"]` au niveau de l'objet schema |

**Action de l'agent :** Corriger le manifest automatiquement et réessayer. Utiliser le fichier `manifest-template.json` comme référence.

### 400 MISSING_PROMPT — "Flow missing prompt"

**Cause :** Le champ `prompt` est vide ou manquant dans le body de la requête.

**Action de l'agent :** Ajouter le prompt markdown et réessayer.

---

## Erreurs d'exécution

### 400 DEPENDENCY_NOT_SATISFIED — "Required provider not connected"

**Diagnostic autonome :**
```
GET {BASE_URL}/api/flows/{packageId}
```
Vérifier le champ `providers` dans la réponse. Identifier les providers avec `status: "disconnected"` ou `"expired"`.

```
GET {BASE_URL}/auth/integrations
```
Vérifier le `authMode` du provider pour chaque provider manquant.

**Actions de l'agent (selon authMode) :**

| authMode | Action |
|----------|--------|
| `api_key` | Demander à l'utilisateur la clé API externe → `POST /auth/connect/{providerId}/api-key` |
| `custom` | Lire le `credentialSchema` du provider → demander les valeurs à l'utilisateur → `POST /auth/connect/{providerId}/credentials` |
| `oauth2` | `POST /auth/connect/{providerId}` → donner l'`authUrl` à l'utilisateur → vérifier via `GET /auth/integrations` après |
| (admin mode) | Vérifier si l'admin a une connexion active → `POST /api/flows/{packageId}/providers/{providerId}/bind` |

### 400 CONFIG_INCOMPLETE — "Required config fields missing"

**Diagnostic autonome :**
```
GET {BASE_URL}/api/flows/{packageId}
```
Comparer `config` (valeurs actuelles) avec `manifest.config.schema` (champs attendus). Identifier les champs `required` qui sont manquants.

**Actions de l'agent :**
1. Si les champs manquants ont une valeur `default` dans le schema → les remplir automatiquement via `PUT /api/flows/{packageId}/config`
2. Si les champs n'ont pas de default → demander les valeurs à l'utilisateur, puis les sauvegarder

### 400 VALIDATION_ERROR — Erreur de validation de l'input

**Diagnostic autonome :**
```
GET {BASE_URL}/api/flows/{packageId}
```
Lire `manifest.input.schema` → vérifier les champs `required` et les types attendus.

**Actions de l'agent :**
1. Comparer l'input envoyé au schema
2. Identifier les champs manquants ou mal typés
3. Corriger et réessayer

### Exécution en status "failed"

**Diagnostic autonome :**
```
GET {BASE_URL}/api/executions/{executionId}
```
Lire le champ `error`.

```
GET {BASE_URL}/api/executions/{executionId}/logs
```
Parcourir les logs pour identifier le point de défaillance. Les logs de type `error` contiennent les détails.

**Causes fréquentes et actions :**
- **Timeout** : L'agent a dépassé le délai (`execution.timeout`). Si possible, augmenter le timeout dans le manifest et réessayer.
- **LLM Error** : Erreur du modèle LLM (rate limit, clé API invalide). C'est un problème de configuration serveur — informer l'utilisateur.
- **Service API Error** : L'API externe a renvoyé une erreur. Lire les logs pour le code HTTP, vérifier les `authorizedUris` du provider via `GET /api/providers`.

### Exécution en status "timeout"

**Diagnostic autonome :**
```
GET {BASE_URL}/api/flows/{packageId}
```
Lire `manifest.execution.timeout` pour connaître le délai actuel.

**Actions de l'agent :**
1. Augmenter le timeout dans le manifest si nécessaire
2. Ou simplifier le prompt/la tâche
3. Ou découper en plusieurs flows plus petits

### 409 EXECUTION_IN_PROGRESS

**Diagnostic autonome :**
```
GET {BASE_URL}/api/flows/{packageId}/executions?limit=5
```
Trouver l'exécution en cours (`status: "running"` ou `"pending"`).

**Actions de l'agent :**
1. Attendre la fin : poll `GET /api/executions/{executionId}` toutes les 3-5 secondes
2. Ou annuler : `POST /api/executions/{executionId}/cancel`, puis relancer

---

## Erreurs de provider

### 409 lors de la suppression d'un provider

**Diagnostic autonome :**
```
GET {BASE_URL}/api/flows
```
Chercher dans les manifests les providers qui référencent ce provider (clés dans `requires.providers`).

**Actions de l'agent :**
1. Lister les flows qui utilisent ce provider
2. Mettre à jour ou supprimer ces flows d'abord
3. Puis réessayer la suppression du provider

### Connexion OAuth2 qui échoue

**Diagnostic autonome :**
```
GET {BASE_URL}/api/providers
```
Vérifier la configuration du provider (authorizationUrl, tokenUrl, scopes).

**Actions de l'agent :**
1. Vérifier que les URLs OAuth sont correctes
2. Si le problème persiste, informer l'utilisateur que le `clientId`/`clientSecret` ou l'URL de callback est probablement mal configuré côté provider externe

---

## Erreurs de packages (skills/extensions)

### 409 FLOW_IN_USE lors de la suppression

**Diagnostic autonome :**
```
GET {BASE_URL}/api/packages/skills/{skillId}
GET {BASE_URL}/api/packages/extensions/{extensionId}
```
La réponse contient un champ `flows` listant les flows qui référencent cette ressource.

**Actions de l'agent :**
1. Pour chaque flow référencé, dissocier la ressource :
   ```
   PUT /api/flows/{packageId}/skills
   { "skillIds": ["@scope/remaining-skill-1", "@scope/remaining-skill-2"] }
   ```
2. Puis réessayer la suppression

### 403 lors de la modification d'un built-in

**Cause :** Les skills et extensions built-in (source: `"built-in"`) ne peuvent pas être modifiés ni supprimés via l'API.

**Action de l'agent :** Créer une copie en tant que skill/extension d'organisation avec un ID différent, puis utiliser cette copie.

---

## Erreurs de rate limiting

### 429 RATE_LIMITED

**Cause :** Trop de requêtes sur un endpoint limité.

**Limites :**
| Endpoint | Limite |
|----------|--------|
| `POST /api/flows/:id/run` | 20/min |
| `POST /api/flows/import` | 10/min |
| `POST /api/flows` | 10/min |

**Action de l'agent :** Attendre 60 secondes avant de réessayer. Implémenter un backoff exponentiel si l'erreur persiste.

---

## Checklist de pré-exécution autonome

Avant de lancer un flow, **exécuter ces vérifications** (pas les demander à l'utilisateur) :

```
GET /api/flows/{packageId}
```

Puis vérifier dans la réponse :

- [ ] `providers[].status === "connected"` pour tous les providers → sinon, résoudre (voir DEPENDENCY_NOT_SATISFIED)
- [ ] `providers[].adminConnection` est défini pour les providers en mode admin → sinon, binder
- [ ] `config` contient tous les champs `required` du `manifest.config.schema` → sinon, remplir via `PUT /api/flows/{packageId}/config`
- [ ] L'input prévu respecte `manifest.input.schema` (champs required + types) → sinon, corriger
- [ ] `runningExecutions === 0` → sinon, attendre ou annuler l'exécution en cours
