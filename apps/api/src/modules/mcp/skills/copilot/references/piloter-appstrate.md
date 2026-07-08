# Agir sur Appstrate (sans dupliquer le platform MCP)

> Dans le chat, tu pilotes Appstrate via le **platform MCP** : `search_operations` →
> `describe_operation` → `invoke_operation`. **C'est lui la source de vérité** des opérations
> et de leurs paramètres (avec ses propres `instructions`). Ne réapprends pas l'API ici —
> découvre-la avec ces tools. Ce mémo ne liste que les **intentions** propres au copilote et
> l'**ordre** à respecter.

## Intentions à chercher (via `search_operations`)

- voir les intégrations disponibles et **ce qui est déjà connecté** ;
- **démarrer une connexion** (OAuth → récupérer le lien à présenter au user ; ou champs / clé API) ;
- lister les **skills** disponibles ; **importer un skill depuis un repo GitHub** (whitelisté) ;
- **valider un agent en dry-run** (sans coût) ;
- importer un package ; lancer un agent ; le **planifier** (cron).

Les noms et paramètres exacts : `describe_operation`. Ne hardcode pas d'URL.

## Règles d'ordre propres au copilote

1. **Avant de proposer une connexion**, vérifie ce qui est déjà connecté — ne propose que le manquant.
2. **Liens de connexion** : pour un connecteur manquant, démarre la connexion OAuth et **présente
   l'URL comme un lien cliquable** dans le chat (« Connecte Gmail → ») ; pour une clé API, demande-la.
3. **Dry-run avant import** : valide toujours l'agent généré avant de l'importer (0 crédit).
4. **Récupérer un skill** : d'abord l'org, sinon import depuis un repo **whitelisté** — validation
   obligatoire (voir `sources-et-securite.md`).
5. Tout passe par les **permissions du user** (le platform MCP réapplique l'auth/RBAC à chaque appel).
6. **Connexion qui échoue** : si générer un lien OAuth renvoie une erreur (ex. **403** = pas de client
   OAuth configuré pour ce service sur l'instance), **ne réessaie pas en boucle**. Explique-le
   simplement (« l'intégration X n'est pas encore configurée ici — un admin doit ajouter les
   credentials d'app ») et propose une **alternative** (un autre connecteur, un export CSV/collé, ou
   faire sans pour démarrer).
7. **Ne régénère pas un lien déjà donné** : si tu as déjà fourni le lien de connexion d'un service
   dans la conversation, réutilise-le — ne rappelle pas l'opération OAuth à chaque tour.
