# Unified Pi Chat, rapport de validation locale

Date : 18 août 2026  
Destinataire : Pierre  
Branche : `feat/chat-pi-unified-engine-phase4`  
Décision locale : **NO GO pour un canary en l'état**

## Synthèse

Le banc contrôlé isole le coût des moteurs derrière le même faux fournisseur OpenAI compatible,
avec les mêmes réponses, 128 tokens d'entrée, 32 tokens de sortie et un appel modèle par tour.
Sur 180 observations agrégées, soit 9 780 conversations mesurées, toutes les conversations ont
terminé. Il n'y a eu aucun 429, aucune erreur serveur, aucun stream incomplet, aucun marqueur
étranger et aucun défaut de persistance ou d'attribution d'usage.

Pi échoue néanmoins aux trois seuils de non-infériorité à 60, 64 et 100 conversations. Sur le profil
S chaud, son p95 au premier token vaut entre 4,26 et 8,50 fois celui d'AI SDK. Sa durée totale vaut
entre 2,53 et 4,20 fois celle d'AI SDK. Son débit représente entre 24,9 % et 41,0 % du débit AI SDK.
Le scénario H avec historique et parties structurées confirme la même direction.

La mémoire RSS ne montre pas de surcoût marginal Pi stable. Les intervalles de pente traversent
zéro, car les processus frais, PGlite et la pression mémoire locale produisent une variance trop
forte. Le microprofil de chargement mesure en revanche un coût fixe Pi médian de 265,9 Mio de RSS,
avec une plage de 71,5 à 360,7 Mio sur dix processus. Cette mesure est locale et constitue un ordre
de grandeur, pas un budget de réplica.

Le comparatif réel Mistral n'a pas été exécuté, car aucune `MISTRAL_API_KEY` n'est disponible. Les
essais Pi par abonnements Codex et Claude Code n'ont pas été exécutés : Chrome Beta atteint bien le
worktree sur le port 3400, mais une interface d'extension ouverte bloque l'automatisation. Ils ne
sont en aucun cas remplacés par un comparatif AI SDK.

La capacité cloud reste inconnue. Le résultat local suffit cependant à interdire le canary tant que
la régression de latence propre au moteur n'est pas expliquée et corrigée.

## Périmètre exécuté

- Forme S, profils froid et chaud, concurrences 1, 10, 30, 60, 64 et 100, cinq répétitions.
- Forme H, profils froid et chaud, concurrences 60, 64 et 100, cinq répétitions.
- Récupération mémoire à 30, 60 et 120 secondes pour S à 60, 64 et 100.
- Dix processus frais pour le coût du chargement Pi au-dessus du package AI SDK déjà chargé.
- Base PGlite distincte par cellule, organisations, utilisateurs, applications et sessions
  synthétiques.
- Plafond Pi porté volontairement à 128 dans le banc contrôlé afin de mesurer le moteur à 100.
- Tests séparés du plafond Appstrate par défaut à 64 et du refus 429 sans message orphelin.

Ne sont pas couverts : T avec un nouvel appel d'outil, L, mix M, rafale, rampe, endurance,
fournisseur Mistral réel, OpenRouter Free, abonnements Pi réels et profil de réplica cloud.

## Environnement

| Élément                  | Valeur                                           |
| ------------------------ | ------------------------------------------------ |
| Machine                  | Apple M2, 8 cœurs, 16 Gio                        |
| Système                  | macOS 26.5.2, arm64                              |
| Bun exécuté              | 1.3.10                                           |
| Bun déclaré par le dépôt | 1.3.14                                           |
| Port applicatif          | 3400 uniquement                                  |
| Base du banc             | PGlite isolée par cellule                        |
| Fournisseur contrôlé     | SSE OpenAI compatible déterministe, en processus |
| Taille de réponse        | 128 tokens d'entrée, 32 tokens de sortie         |
| Échantillonnage          | 100 ms                                           |

L'API du worktree répond `healthy` sur `/health` au port 3400. Elle est actuellement raccordée au
PostgreSQL local partagé sur 5423. Cette base ne compte que 13 migrations Drizzle et ne possède pas
encore `llm_usage.chat_session_id`. Elle n'a pas été migrée, afin de ne pas modifier l'état partagé
avec d'autres projets, et elle n'a servi à aucune mesure. La reprise navigateur doit utiliser une
base dédiée au worktree avec le schéma courant, ou faire l'objet d'une autorisation explicite de
mise à niveau de la base partagée.

Les fichiers bruts ont été produits avant les derniers commits de rapport. Chaque observation
contient son commit exact. Les synthèses versionnées conservent le chemin de chaque observation
source.

## Résultats principaux, forme S chaude

Les valeurs sont les médianes de cinq répétitions. Les intervalles entre crochets sont les
intervalles bootstrap non paramétriques à 95 % produits avec une graine fixe.

| Concurrence | Moteur | p95 premier token, ms |        p95 total, ms |      Chats par seconde |           Pic RSS, Mio |
| ----------: | ------ | --------------------: | -------------------: | ---------------------: | ---------------------: |
|          60 | AI SDK |      527 [402, 1 935] |   1 338 [949, 2 486] |   42,30 [23,45, 58,21] |   624,9 [458,2, 877,8] |
|          60 | Pi     |  4 473 [2 166, 8 967] | 5 616 [2 781, 9 807] |    10,52 [6,06, 21,09] |   494,4 [478,3, 856,1] |
|          64 | AI SDK |        559 [285, 667] |   1 145 [576, 1 563] |  52,77 [39,15, 103,92] | 676,3 [559,1, 1 040,5] |
|          64 | Pi     |  2 379 [1 428, 4 612] | 2 894 [1 733, 5 240] |   21,62 [12,06, 36,13] |   637,4 [528,4, 712,3] |
|         100 | AI SDK |        413 [362, 814] |     877 [730, 1 316] | 107,43 [72,98, 128,17] | 904,9 [487,8, 1 039,8] |
|         100 | Pi     |  2 172 [2 004, 4 218] | 3 555 [2 446, 4 589] |   27,09 [21,53, 39,89] |   705,4 [633,2, 863,2] |

Les écarts par rapport à AI SDK sont les suivants.

| Concurrence | Profil | Ratio Pi premier token | Ratio Pi total | Débit Pi sur AI SDK |
| ----------: | ------ | ---------------------: | -------------: | ------------------: |
|          60 | froid  |                   3,31 |           1,95 |              52,1 % |
|          60 | chaud  |                   8,50 |           4,20 |              24,9 % |
|          64 | froid  |                   2,88 |           2,19 |              47,7 % |
|          64 | chaud  |                   4,26 |           2,53 |              41,0 % |
|         100 | froid  |                   5,02 |           3,24 |              32,3 % |
|         100 | chaud  |                   5,26 |           4,05 |              25,2 % |

Tous ces points échouent au seuil de premier token, au seuil de durée totale et au seuil de débit.

## Confirmation avec historique structuré

La forme H contient dix messages historiques, une partie de raisonnement, un appel d'outil
historique et son résultat structuré. À 60 chats chauds, Pi mesure 1 481 ms au premier token contre
314 ms pour AI SDK, puis 1 847 ms au total contre 670 ms. À 100 chats chauds, Pi mesure 2 922 ms
au premier token contre 532 ms, puis 3 638 ms au total contre 1 061 ms.

Les parties structurées sont persistées. Selon la concurrence, chaque observation H contient entre
183 et 407 parties persistées. Aucun mélange inter-organisation n'a été détecté.

## Coût fixe et coût marginal

### Coût fixe du chargement Pi

`chat-stream.ts` importe Pi statiquement. Le coût est donc payé par le processus Unified Chat avant
même qu'une conversation AI SDK soit routée. Un microprofil frais charge le package AI SDK, force
un passage du ramasse-miettes, mesure, importe `pi-chat/engine.ts`, puis mesure à nouveau.

Sur dix répétitions :

- durée d'import médiane : 265,0 ms, minimum 185,9 ms, maximum 1 228,9 ms ;
- delta RSS médian : 265,9 Mio, minimum 71,5 Mio, maximum 360,7 Mio ;
- delta heap logique médian : 673,9 Mio ;
- delta mémoire externe médian : 654,9 Mio ;
- delta buffers médian : 490,4 Mio.

Les catégories Bun se recouvrent et ne doivent pas être additionnées. Le heap logique peut dépasser
le RSS résident, notamment avec les pages virtuelles et Wasm. La plage RSS large impose de rejouer
ce probe dans le conteneur cloud avant tout dimensionnement.

### Coût marginal des conversations chaudes

Les pentes RSS appariées entre 1 et 100 chats, en octets par chat, ont toutes un intervalle à 95 %
qui traverse zéro :

| Profil | Moteur |    Médiane |       Intervalle à 95 % |
| ------ | ------ | ---------: | ----------------------: |
| froid  | AI SDK |   -290 775 | [-1 660 576, 1 706 418] |
| froid  | Pi     | -2 306 669 | [-3 198 190, 2 889 211] |
| chaud  | AI SDK |  2 311 302 | [-2 417 716, 3 090 784] |
| chaud  | Pi     |   -523 792 | [-2 476 135, 2 950 113] |

Conclusion : la pente locale n'est pas estimable avec cette isolation par processus et la variance
PGlite. Il serait incorrect d'en déduire que Pi libère de la mémoire à chaque chat.

## Récupération mémoire

Les douze cellules de récupération possèdent les six checkpoints requis. Le RSS après 120 secondes
est inférieur au RSS initial chaud augmenté de 10 % dans chaque cellule. Cela ne prouve pas
l'absence de rétention logique : à 100 chats chauds Pi, le RSS descend de 608,7 Mio à 126,9 Mio,
alors que le heap logique passe à 955,7 Mio et la mémoire externe à 879,7 Mio. Les séries RSS,
heap, externe et buffers doivent donc être lues séparément.

Une cellule Pi froide à 100 présente aussi un rebond RSS à 60 secondes, 333,0 Mio contre 114,9 Mio
à 30 secondes et 96,2 Mio à 120 secondes. Une seule répétition longue ne permet pas de conclure à
une fuite ou à une régression.

## Persistance, usage, continuité et isolation

Sur les 180 observations principales :

| Mesure                                   |                       Résultat |
| ---------------------------------------- | -----------------------------: |
| Conversations demandées et terminées     |                9 780 sur 9 780 |
| 429                                      |                              0 |
| Erreurs serveur                          |                              0 |
| Streams incomplets                       |                              0 |
| Marqueurs incorrects                     |                              0 |
| Appels modèle                            |                          9 780 |
| Tokens d'entrée                          |                      1 251 840 |
| Tokens de sortie                         |                        312 960 |
| Messages persistés                       |                         20 010 |
| Parties structurées persistées           |                         35 085 |
| Lignes d'usage persistées                |                         10 050 |
| Continuité                               | valide dans chaque observation |
| Isolation session et attribution d'usage | valide dans chaque observation |

Les lignes supplémentaires d'usage proviennent des warmups et des tours de continuité, exclus des
compteurs de la vague mais volontairement persistés et vérifiés.

## Limites séparées

### Limite du moteur

Le fournisseur déterministe et le volume de tokens étant identiques, l'écart de latence contrôlé se
situe dans le chemin moteur Pi, sa conversion, son orchestration de stream ou sa contention de boucle
événementielle. Le p95 de délai de boucle mesuré uniquement pendant les vagues chaudes S vaut 363 ms
pour AI SDK contre 4 183 ms pour Pi à 60, puis 316 ms contre 2 024 ms à 100.

### Limite du fournisseur

Aucune limite Mistral, OpenRouter, Codex ou Claude ne peut être affirmée. Aucun appel réel à ces
fournisseurs n'a été réalisé dans cette campagne.

### Limite de politique Appstrate

Le plafond Pi par défaut est 64. Les tests vérifient le 429 RFC 9457, `Retry-After`, la libération du
slot à la fermeture et l'absence de persistance du message utilisateur refusé. Le banc contrôlé a
utilisé 128 uniquement pour observer la capacité moteur à 100. En configuration par défaut, une
vague instantanée de 100 doit donc refuser les requêtes excédant les 64 slots actifs.

### Limite cloud

Le nombre de réplicas, leur mémoire et CPU, l'autoscaling, les redémarrages, la concurrence p99 et
la distribution réelle des tokens et outils ne sont pas disponibles. Aucun chiffre local ne doit
être présenté comme capacité cloud.

## Fournisseurs réels encore nécessaires

1. Fournir une clé Mistral dans un fichier local explicitement passé au harness. Exécuter trois
   répétitions A/B strictement identiques à 60, 64 et 100.
2. Utiliser OpenRouter Free uniquement si un second fournisseur est nécessaire pour confirmer une
   conclusion, jamais pour remplacer Mistral silencieusement.
3. Fermer l'interface d'extension qui bloque Chrome Beta. Rejouer Pi avec GPT 5.4 Mini via
   abonnement Codex et Claude Haiku 4.5 via abonnement Claude Code à 1, 10 et 30. Ne tenter 60 que
   si les politiques et les limites fournisseur l'autorisent.
4. Raccorder d'abord le port 3400 à une base dédiée et migrée. Ne pas mettre à niveau la base locale
   partagée sans autorisation.
5. Ne jamais présenter Codex ou Claude Code comme comparaison directe avec AI SDK.

## Données cloud nécessaires

- RSS et CPU par réplica API, limites et redémarrages ;
- minimum, maximum et nombre courant de réplicas ;
- politique d'autoscaling et délai de démarrage ;
- chats actifs p50, p95, p99 et maximum sur quatorze jours ;
- nouveaux tours par seconde et rafales ;
- distributions des tokens d'historique, appels d'outils, modèles et fournisseurs ;
- délai de boucle du moteur actuel ;
- image exacte et limites 512 Mio, 1 Gio, 2 Gio ou 8 Gio à reproduire si le profil final reste
  inconnu.

## Commandes de reproduction

Depuis la racine du worktree :

```bash
TEST_TIER=0 bun test scripts/chat-engine-performance.test.ts scripts/chat-engine-performance-report.test.ts
bunx tsc --noEmit -p scripts/tsconfig.json

bun scripts/chat-engine-performance.ts controlled --forms=S --profiles=cold,warm --concurrency=1,10,30 --repetitions=5 --recovery-ms=0 --output=artifacts/chat-engine-performance/controlled-s-low-r5
bun scripts/chat-engine-performance.ts controlled --forms=S --profiles=cold,warm --concurrency=60,64,100 --repetitions=5 --recovery-ms=0 --output=artifacts/chat-engine-performance/controlled-s-high-r5
bun scripts/chat-engine-performance.ts controlled --forms=H --profiles=cold,warm --concurrency=60,64,100 --repetitions=5 --recovery-ms=0 --output=artifacts/chat-engine-performance/controlled-h-high-r5
bun scripts/chat-engine-performance.ts controlled --forms=S --profiles=cold,warm --concurrency=60,64,100 --repetitions=1 --recovery-ms=120000 --output=artifacts/chat-engine-performance/controlled-s-recovery-120s

bun scripts/chat-pi-fixed-load.ts --repetitions=10 --output=artifacts/chat-engine-performance/fixed-load-r10 --summary-output=docs/architecture/performance-results/2026-08-18-pi-fixed-load.v1.json

bun scripts/chat-engine-performance-report.ts --input=artifacts/chat-engine-performance/controlled-s-low-r5,artifacts/chat-engine-performance/controlled-s-high-r5,artifacts/chat-engine-performance/controlled-h-high-r5 --output=docs/architecture/performance-results/2026-08-18-controlled-summary.v1.json
bun scripts/chat-engine-performance-report.ts --input=artifacts/chat-engine-performance/controlled-s-recovery-120s --output=docs/architecture/performance-results/2026-08-18-controlled-recovery.v1.json

TEST_TIER=0 bun test packages/module-chat/test/pi-chat-concurrency.test.ts packages/module-chat/test/chat-stream-handler.test.ts packages/module-chat/test/pi-chat-engine-selection.test.ts packages/module-chat/test/pi-chat-model-binding.test.ts
```

Comparatif Mistral, lorsque la clé sera disponible :

```bash
bun scripts/chat-engine-performance.ts mistral --env-file=/chemin/absolu/mistral.env --model=mistral-small-2603 --forms=S,H --profiles=cold,warm --concurrency=60,64,100 --repetitions=3 --recovery-ms=120000 --output=artifacts/chat-engine-performance/mistral-real
```

Le fichier d'environnement doit contenir uniquement la clé attendue ou, au minimum, le harness ne
lit explicitement que `MISTRAL_API_KEY`. La clé n'est jamais copiée dans les observations.

## Requêtes SQL de contrôle

À exécuter sur la base isolée d'une cellule conservée :

```sql
SELECT
  s.id,
  s.org_id,
  s.user_id,
  count(m.seq) AS persisted_messages,
  sum(jsonb_array_length(coalesce(m.content -> 'parts', '[]'::jsonb))) AS structured_parts
FROM chat_sessions s
LEFT JOIN chat_messages m ON m.session_id = s.id
WHERE s.id LIKE 'chs_%'
GROUP BY s.id, s.org_id, s.user_id
ORDER BY s.id;

SELECT
  u.chat_session_id,
  u.org_id,
  u.user_id,
  count(*) AS model_calls,
  sum(u.input_tokens) AS input_tokens,
  sum(u.output_tokens) AS output_tokens,
  sum(u.cache_read_tokens) AS cache_read_tokens,
  sum(u.cache_write_tokens) AS cache_write_tokens,
  sum(u.cost_usd) AS cost_usd
FROM llm_usage u
WHERE u.chat_session_id LIKE 'chs_%'
GROUP BY u.chat_session_id, u.org_id, u.user_id
ORDER BY u.chat_session_id;

SELECT count(*) AS cross_tenant_usage_rows
FROM llm_usage u
JOIN chat_sessions s ON s.id = u.chat_session_id
WHERE u.org_id IS DISTINCT FROM s.org_id
   OR u.user_id IS DISTINCT FROM s.user_id;
```

Le dernier résultat attendu est zéro.

## Artifacts versionnés

- Schéma brut : [CHAT_PI_PERFORMANCE_OBSERVATION.schema.json](./CHAT_PI_PERFORMANCE_OBSERVATION.schema.json)
- Synthèse contrôlée et références vers 180 observations : [2026-08-18-controlled-summary.v1.json](./performance-results/2026-08-18-controlled-summary.v1.json)
- Récupération mémoire et références vers 12 observations : [2026-08-18-controlled-recovery.v1.json](./performance-results/2026-08-18-controlled-recovery.v1.json)
- Coût fixe Pi et références vers 10 observations : [2026-08-18-pi-fixed-load.v1.json](./performance-results/2026-08-18-pi-fixed-load.v1.json)

Les observations volumineuses et leurs bases restent sous `artifacts/chat-engine-performance/`, hors
Git. Leur `schemaVersion` vaut 1. Aucun secret ni contenu réel n'y figure.

## Entrée du journal de décision RFC

**18 août 2026, validation locale contrôlée : NO GO avant canary.** Le banc déterministe a terminé
9 780 conversations mesurées sans erreur fonctionnelle, perte de persistance ni contamination.
Pi échoue toutefois aux seuils de non-infériorité de latence et débit à 60, 64 et 100. La mémoire
marginale locale reste non concluante et la capacité cloud est inconnue. Le comparatif Mistral est
bloqué par l'absence de clé. Les essais Codex et Claude Code restent Pi uniquement et sont bloqués
par la validation Chrome Beta. AI SDK reste déployable. Aucun canary, aucune migration de trafic et
aucune suppression d'AI SDK ne sont autorisés à ce stade.

La RFC source se trouve hors du worktree autorisé. Cette entrée est donc fournie ici, prête à être
reportée dans son journal sans modifier le satellite externe.
