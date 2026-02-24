# Troubleshooting Appstrate

Guide de diagnostic et résolution des erreurs courantes lors de l'utilisation de l'API Appstrate.

## Diagnostic rapide

Avant toute investigation, vérifier ces points dans l'ordre :

1. **L'API est-elle accessible ?** → `GET https://appstrate.com/health`
2. **L'authentification est-elle valide ?** → `GET https://appstrate.com/api/flows` (doit retourner 200)
3. **Le flow existe-t-il ?** → `GET https://appstrate.com/api/flows/{flowId}` (doit retourner 200)

---

## Erreurs d'authentification

### 401 Unauthorized — "Missing or invalid authentication"

**Causes possibles :**
- Clé API manquante ou mal formatée dans le header
- Clé API expirée ou révoquée
- Header `Authorization` mal formé

**Diagnostic :**
```
curl -v https://appstrate.com/api/flows \
  -H "Authorization: Bearer ask_..."
```

**Solutions :**
1. Vérifier le format : `Authorization: Bearer ask_<48 hex chars>`
2. Demander à l'utilisateur de vérifier que la clé est toujours active dans **Organization Settings > API Keys**
3. Si la clé est expirée, demander à l'utilisateur d'en créer une nouvelle

### 403 Forbidden — "Insufficient permissions"

**Cause :** L'utilisateur associé à la clé API n'a pas le rôle `admin` ou `owner` dans l'organisation.

**Solution :** Les opérations d'écriture (créer un flow, modifier un provider, etc.) nécessitent le rôle admin. Demander à l'utilisateur de vérifier son rôle dans **Organization Settings**.

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

### 400 NAME_COLLISION — "Flow ID already exists"

**Cause :** Un flow avec cet ID existe déjà dans l'organisation.

**Solutions :**
1. Choisir un ID différent
2. Si c'est une mise à jour, utiliser `PUT /api/flows/{flowId}` au lieu de `POST /api/flows`

### 400 INVALID_MANIFEST — Erreurs de validation du manifest

**Erreurs fréquentes dans le manifest :**

| Erreur | Cause | Solution |
|--------|-------|----------|
| `metadata.id: Required` | Champ `id` manquant dans metadata | Ajouter `"id": "mon-flow"` dans metadata |
| `metadata.displayName: Required` | Pas de nom d'affichage | Ajouter `"displayName": "Mon Flow"` |
| `requires.services: Required` | Section services manquante | Ajouter `"services": []` même si vide |
| `input.schema.required: Expected array` | `required: true` sur une propriété | Utiliser `"required": ["field1"]` au niveau de l'objet schema |

**Astuce :** Utiliser le fichier `manifest-template.json` inclus dans ce skill comme base.

### 400 MISSING_PROMPT — "Flow missing prompt"

**Cause :** Le champ `prompt` est vide ou manquant dans le body de la requête.

**Solution :** Ajouter le prompt markdown. Même un prompt minimal suffit :
```json
{ "prompt": "# Mon Agent\n\nTu es un agent qui..." }
```

---

## Erreurs d'exécution

### 400 DEPENDENCY_NOT_SATISFIED — "Required service not connected"

**Cause :** Le flow requiert un service (ex: Gmail) mais l'utilisateur ne l'a pas connecté.

**Diagnostic :**
```
GET https://appstrate.com/api/flows/{flowId}
```
Vérifier le champ `services` dans la réponse. Chaque service a un `status` (`connected`, `disconnected`, `expired`).

**Solutions :**
1. Lister les intégrations : `GET https://appstrate.com/auth/integrations`
2. Connecter le service manquant via le endpoint approprié (`/auth/connect/{provider}/...`)
3. Pour les services en mode `admin` : l'admin doit binder sa connexion → `POST /api/flows/{flowId}/services/{serviceId}/bind`

### 400 CONFIG_INCOMPLETE — "Required config fields missing"

**Cause :** Le flow a un `config.schema` avec des champs obligatoires non remplis.

**Diagnostic :**
```
GET https://appstrate.com/api/flows/{flowId}
```
Comparer `config` (valeurs actuelles) avec `manifest.config.schema` (champs attendus).

**Solution :**
```
PUT https://appstrate.com/api/flows/{flowId}/config
Content-Type: application/json

{ "missingField": "value" }
```

### 400 VALIDATION_ERROR — Erreur de validation de l'input

**Cause :** L'input fourni au `POST /api/flows/{flowId}/run` ne correspond pas au `input.schema` du manifest.

**Diagnostic :**
1. Récupérer le schema : `GET https://appstrate.com/api/flows/{flowId}` → `manifest.input.schema`
2. Vérifier que les champs `required` sont tous présents dans l'input
3. Vérifier les types (string vs number vs boolean)

### Exécution en status "failed"

**Diagnostic :**
```
GET https://appstrate.com/api/executions/{executionId}
```
Lire le champ `error` pour le message d'erreur.

```
GET https://appstrate.com/api/executions/{executionId}/logs
```
Parcourir les logs pour identifier à quel moment l'exécution a échoué. Les logs de type `error` contiennent les détails.

**Causes fréquentes :**
- **Timeout** : L'agent a dépassé le délai (`execution.timeout`). Augmenter le timeout dans le manifest ou simplifier la tâche.
- **LLM Error** : Erreur du modèle LLM (rate limit, clé API invalide). Vérifier la configuration des clés LLM côté serveur.
- **Service API Error** : L'API externe appelée via le sidecar a renvoyé une erreur. Vérifier les logs pour le code HTTP de l'API cible.

### Exécution en status "timeout"

**Cause :** L'exécution a dépassé le `execution.timeout` défini dans le manifest (en secondes).

**Solutions :**
1. Augmenter le timeout dans le manifest (ex: `"timeout": 600` pour 10 minutes)
2. Simplifier le prompt pour réduire le travail de l'agent
3. Découper la tâche en plusieurs flows plus petits

### 409 EXECUTION_IN_PROGRESS

**Cause :** Il y a déjà une exécution en cours pour ce flow et cet utilisateur.

**Solutions :**
1. Attendre la fin de l'exécution en cours : `GET https://appstrate.com/api/executions/{executionId}`
2. Annuler l'exécution en cours : `POST https://appstrate.com/api/executions/{executionId}/cancel`

---

## Erreurs de provider

### 409 lors de la suppression d'un provider

**Cause :** Le provider est encore référencé par un ou plusieurs flows.

**Diagnostic :** Identifier les flows qui utilisent ce provider :
```
GET https://appstrate.com/api/flows
```
Chercher dans les manifests les services qui référencent ce provider.

**Solution :** Supprimer ou modifier les flows concernés avant de supprimer le provider.

### Connexion OAuth2 qui échoue

**Diagnostic :**
1. Vérifier que le provider a les bons `authorizationUrl` et `tokenUrl`
2. Vérifier que le `clientId` et `clientSecret` sont corrects
3. Vérifier que le `OAUTH_CALLBACK_URL` dans la configuration serveur correspond à l'URL autorisée dans la console du provider externe
4. Vérifier les scopes demandés sont valides pour ce provider

---

## Erreurs de library (skills/extensions)

### 409 FLOW_IN_USE lors de la suppression

**Cause :** Le skill ou l'extension est encore référencé par un ou plusieurs flows.

**Diagnostic :**
```
GET https://appstrate.com/api/library/skills/{skillId}
GET https://appstrate.com/api/library/extensions/{extensionId}
```
La réponse contient un champ `flows` listant les flows qui référencent cette ressource.

**Solution :** Dissocier la ressource des flows avant de la supprimer :
```
PUT https://appstrate.com/api/flows/{flowId}/skills
{ "skillIds": [] }
```

### 403 lors de la modification d'un built-in

**Cause :** Les skills et extensions built-in (source: `"built-in"`) ne peuvent pas être modifiés ni supprimés via l'API.

**Solution :** Créer une copie en tant que skill/extension d'organisation avec un ID différent.

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

**Solution :** Attendre 60 secondes avant de réessayer. Implémenter un backoff exponentiel si l'erreur persiste.

---

## Checklist de pré-exécution

Avant de lancer un flow, vérifier systématiquement :

- [ ] Le flow existe : `GET /api/flows/{flowId}` → 200
- [ ] Tous les services sont connectés : vérifier `services[].status === "connected"` dans le flow detail
- [ ] Les services admin sont bindés : vérifier `services[].adminConnection` pour les services en mode admin
- [ ] La configuration est complète : vérifier `config` contient tous les champs `required` du schema
- [ ] L'input est valide : vérifier les champs `required` du `input.schema` et les types
- [ ] Pas d'exécution en cours : vérifier `runningExecutions === 0` dans le flow detail (ou gérer le 409)
