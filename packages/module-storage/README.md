# @appstrate/module-storage

Module Appstrate — **storage** : la capacité « les octets & les disques » de la plateforme.

**Opt-in** : ajouter `@appstrate/module-storage` à `MODULES`. Désactivé = zéro empreinte (les tables `storage_disks`/`storage_objects` vivent dans le schéma core et restent inertes).

## Modèle

Repris de la couche disques d'`appstrate-ws` (stratégie §4.1) : un **disque** est un backend opéré par un **driver** (`drivers/`), un **objet** est un fichier sur un disque.

| Disque         | Driver                               | Capacités v1                                       |
| -------------- | ------------------------------------ | -------------------------------------------------- |
| `native`       | `@appstrate/db/storage` (S3/FS)      | upload · download · delete — le disque par défaut  |
| `s3`           | bucket S3 connecté (creds chiffrées) | upload · download · delete · sync (browse)         |
| `google_drive` | Drive connecté (SA ou OAuth user)    | download · sync (browse) — **lecture seule** en v1 |

Le **disque natif par défaut** délègue à `@appstrate/db/storage`, la même façade que les uploads du cœur (S3 si `S3_BUCKET`, sinon fallback FS) — pas de `PlatformServices`, pas de duplication d'env.

## Surfaces

| Surface        | Contenu                                                                                                                                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.` (backend)  | Routes `/api/storage/*` (disques CRUD + sync, objets upload/download/delete + inventaire), RBAC `storage:read/write/delete/manage`, flag `features.storage`, contribution OpenAPI (→ auto-exposé en MCP via `invoke_operation`) |
| `./ui` (front) | `StoragePage` — disques + téléversement + inventaire + download/delete. Feature autonome, aucune dépendance cross-module.                                                                                                       |

## Le contrat (l'`id` opaque + l'ACL chez storage)

La frontière avec les consommateurs (chat, agents, **search** plus tard) = **un `id` opaque stable** + une **API de lecture par id** (`GET /api/storage/objects/:id/content`). Personne ne lit le `driverKey` (clé S3 / file id Drive) ni ne JOIN les tables de storage.

storage est la **source de vérité de l'ACL** des objets (`visibility`/`ownerId`). Le **contrat d'events storage→search** est déjà posé (`src/events.ts`) : un seam local `emitStorageObjectEvent()` (no-op aujourd'hui, aucun consommateur). Quand `module-search` arrivera, le brancher sur le bus = une édition d'une seule fonction — zéro retrofit.

> Règle d'or (stratégie §5) : **events, jamais JOIN ; ACL dans storage, dénormalisée dans search.**

## Hors v1 (avec leur consommateur)

Arbre de dossiers, éditeur de fichiers, move cross-disk, écriture Drive, et le **bus d'events** vers search + l'index lui-même (= `module-search`). Voir l'en-tête de `src/events.ts` pour le pourquoi (razor `PlatformServices` : pas de capacité core sans consommateur).
