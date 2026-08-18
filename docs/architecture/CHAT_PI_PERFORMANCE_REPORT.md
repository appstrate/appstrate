# Unified Pi Chat, rapport de validation locale

Date : 18 août 2026  
Destinataire : Pierre  
Branche : `feat/chat-pi-unified-engine-phase4`  
Décision locale : **NO GO pour un canary en l'état**

## Synthèse

Le banc contrôlé isole le coût des moteurs derrière le même faux fournisseur OpenAI compatible.
Les formes S et H utilisent les mêmes réponses, 128 tokens d'entrée, 32 tokens de sortie et un
appel modèle par tour. La forme T utilise deux appels modèle et un appel MCP identiques.
Sur 280 observations agrégées, soit 18 260 conversations mesurées, toutes les conversations ont
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

Le comparatif réel Mistral a ensuite traversé le vrai serveur Appstrate, son authentification, le
proxy, le ledger et une base PGlite isolée. Sur S froid et S chaud, 2 688 conversations principales
ont terminé, sans 429, erreur, stream incomplet ni défaut d'isolation. Pi reste plus lent, mais
l'écart réel est nettement inférieur à celui du fournisseur déterministe. À 100 organisations
chaudes, le p95 du premier token vaut 4 253 ms pour Pi contre 3 884 ms pour AI SDK. Le débit Pi
représente 85,2 % du débit AI SDK et échoue encore au seuil de 90 %.

Les essais complémentaires Pi par abonnements sont terminés à 1, 10 et 30. Codex avec
`gpt-5.6-luna` et Claude Code avec `claude-haiku-4-5` ont chacun livré 41 conversations principales
sur 41 sans refus, plus leurs tours de continuité. Ils ne constituent pas un comparatif avec AI SDK.
Le niveau 60 n'a pas été tenté, car aucune politique d'abonnement explicite n'autorise cette rafale.

La capacité cloud reste inconnue. Le résultat local suffit cependant à interdire le canary tant que
la régression de latence propre au moteur n'est pas expliquée et corrigée.

## Périmètre exécuté

- Forme S, profils froid et chaud, concurrences 1, 10, 30, 60, 64 et 100, cinq répétitions.
- Forme H, profils froid et chaud, concurrences 60, 64 et 100, cinq répétitions.
- Forme T avec un appel MCP et deux appels modèle, profils froid et chaud, concurrences 60, 64 et
  100, cinq répétitions.
- À 100 chats, distributions 100 organisations par un chat, 10 organisations par dix chats et une
  organisation par cent chats.
- Récupération mémoire à 30, 60 et 120 secondes pour S à 60, 64 et 100.
- Dix processus frais pour le coût du chargement Pi au-dessus du package AI SDK déjà chargé.
- Base PGlite distincte par cellule, organisations, utilisateurs, applications et sessions
  synthétiques. Les credentials réels restent chiffrés et ne figurent dans aucun résultat.
- Plafond Pi porté volontairement à 128 dans le banc contrôlé afin de mesurer le moteur à 100.
- Banc séparé du plafond Appstrate par défaut à 64, avec une vague réelle à 100, et tests du refus
  429 sans message orphelin.

Le banc réel couvre Mistral S froid et chaud à 60, 64 et 100, trois répétitions, ainsi qu'une rampe
exploratoire à 1, 10, 30, 60, 64 et 100 et une récupération de deux minutes. Il couvre aussi Codex
et Claude Code à 1, 10 et 30. Ne sont pas couverts : L, mix M, endurance, OpenRouter Free,
abonnements à 60 et profil de réplica cloud. L, M et l'endurance dépendent de percentiles cloud
absents. Le lancement simultané de chaque vague couvre le profil rafale sous 250 ms.

## Environnement

| Élément                  | Valeur                                            |
| ------------------------ | ------------------------------------------------- |
| Machine                  | Apple M2, 8 cœurs, 16 Gio                         |
| Système                  | macOS 26.5.2, arm64                               |
| Bun exécuté              | 1.3.10                                            |
| Bun déclaré par le dépôt | 1.3.14                                            |
| Port applicatif          | 3400 uniquement                                   |
| Base du banc             | PGlite isolée par cellule                         |
| Fournisseur contrôlé     | SSE OpenAI compatible déterministe, en processus  |
| Fournisseur A/B réel     | Mistral, `mistral-small-2603`, clé d'organisation |
| Abonnements Pi           | Codex `gpt-5.6-luna`, Claude Haiku 4.5            |
| Taille de réponse        | 128 tokens d'entrée, 32 tokens de sortie          |
| Échantillonnage          | 100 ms                                            |

Chaque mesure utilise une base PGlite dédiée et migrée. Le PostgreSQL local sur 5423 sert uniquement
de source aux credentials d'abonnement déjà connectés. Le harness copie leur enveloppe chiffrée
dans la base synthétique, sans copier de données conversationnelles. Le test navigateur Chrome Beta
a atteint la page du port 3400, mais l'automatisation visuelle est restée bloquée par une interface
d'extension ouverte.

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

## Comparatif Mistral réel

Le comparatif utilise `mistral-small-2603` et traverse le vrai endpoint `/api/chat`,
l'authentification Better Auth, la sélection de modèle d'organisation, le proxy Mistral et
`llm_usage`. Les valeurs suivantes sont les médianes de trois répétitions. Les cellules froides
partagent une organisation synthétique. Les cellules chaudes utilisent une organisation par chat.

| Profil | Concurrence | Moteur | p95 premier token, ms | p95 total, ms | Chats par seconde | Pic RSS, Mio |
| ------ | ----------: | ------ | --------------------: | ------------: | ----------------: | -----------: |
| froid  |          60 | AI SDK |                 2 393 |         2 509 |             14,91 |      1 094,7 |
| froid  |          60 | Pi     |                 3 703 |         3 771 |             11,74 |      1 241,3 |
| froid  |          64 | AI SDK |                 2 559 |         2 672 |             15,09 |      1 116,8 |
| froid  |          64 | Pi     |                 3 927 |         3 964 |             14,19 |      1 125,6 |
| froid  |         100 | AI SDK |                 3 964 |         4 022 |             22,92 |      1 202,6 |
| froid  |         100 | Pi     |                 5 210 |         5 265 |             14,66 |      1 244,6 |
| chaud  |          60 | AI SDK |                 2 375 |         2 455 |             17,59 |      1 107,6 |
| chaud  |          60 | Pi     |                 4 340 |         4 381 |             10,87 |        934,5 |
| chaud  |          64 | AI SDK |                 2 506 |         2 593 |             16,47 |        794,4 |
| chaud  |          64 | Pi     |                 3 208 |         3 251 |             15,74 |        785,1 |
| chaud  |         100 | AI SDK |                 3 884 |         3 971 |             20,97 |      1 054,6 |
| chaud  |         100 | Pi     |                 4 253 |         4 300 |             17,87 |      1 000,0 |

Les 2 688 conversations principales terminent, avec exactement 2 688 appels modèle, aucun 429,
aucune erreur, aucun stream incomplet et aucun marqueur incorrect. Le ledger, les messages et les
parties structurées sont persistés. Chaque observation valide la continuité et l'isolation.

À 100 organisations chaudes, Pi respecte le seuil du premier token, car son écart de 369 ms reste
sous AI SDK multiplié par 1,10. Il respecte aussi le seuil de durée totale, avec un ratio de 1,083.
Son débit de 85,2 % reste toutefois sous le seuil de 90 %. À 60 et 64, Pi échoue au moins un seuil
de latence. Le comparatif réel confirme donc la décision NO GO, même si son écart est beaucoup plus
faible que celui du banc contrôlé à 100.

La forme H réelle révèle une incompatibilité distincte : Pi accepte l'historique structuré et
obtient une réponse Mistral, tandis que le chemin AI SDK transforme la partie de raisonnement en un
message assistant séparé que Mistral refuse avant toute écriture d'usage. Cette cellule ne sert pas
à la non-infériorité et reste versionnée comme observation d'anomalie.

## Abonnements Pi réels

Ces mesures sont complémentaires et ne comparent jamais Pi à AI SDK.

| Abonnement             | Concurrence | p95 premier token, ms | p95 total, ms | Chats par seconde | RSS après 120 s, Mio |
| ---------------------- | ----------: | --------------------: | ------------: | ----------------: | -------------------: |
| Codex, GPT 5.6 Luna    |           1 |                 1 962 |         2 184 |              0,46 |           non mesuré |
| Codex, GPT 5.6 Luna    |          10 |                 2 888 |         3 124 |              3,19 |                153,9 |
| Codex, GPT 5.6 Luna    |          30 |                 3 589 |         3 784 |              7,65 |                169,7 |
| Claude Code, Haiku 4.5 |           1 |                 2 316 |         2 344 |              0,43 |           non mesuré |
| Claude Code, Haiku 4.5 |          10 |                 2 506 |         2 540 |              3,93 |                156,8 |
| Claude Code, Haiku 4.5 |          30 |                 3 359 |         3 377 |              8,83 |                161,0 |

Chaque abonnement termine 41 conversations principales sur 41, sans refus ni stream incomplet.
Le nombre d'appels modèle correspond exactement aux conversations. La persistance, l'attribution
d'usage, la continuité et l'isolation passent à tous les niveaux. Le jeton Claude Code expiré a été
rafraîchi par le service Appstrate avant le banc, puis copié uniquement sous forme chiffrée dans les
bases synthétiques. Le niveau 60 n'est pas exécuté faute de politique d'abonnement explicitement
compatible avec cette rafale.

## Confirmation avec historique structuré

La forme H contient dix messages historiques, une partie de raisonnement, un appel d'outil
historique et son résultat structuré. À 60 chats chauds, Pi mesure 1 481 ms au premier token contre
314 ms pour AI SDK, puis 1 847 ms au total contre 670 ms. À 100 chats chauds, Pi mesure 2 922 ms
au premier token contre 532 ms, puis 3 638 ms au total contre 1 061 ms.

Les parties structurées sont persistées. Selon la concurrence, chaque observation H contient entre
183 et 407 parties persistées. Aucun mélange inter-organisation n'a été détecté.

## Outil MCP contrôlé

La forme T part de l'historique H, appelle réellement `controlled_echo`, persiste son résultat
structuré, puis effectue un second appel modèle. Chaque conversation mesure exactement deux appels
modèle, un appel d'outil, 288 tokens d'entrée et 48 tokens de sortie.

Les 4 480 conversations T ont toutes terminé. À 60 chats chauds, le p95 au premier token vaut
599 ms pour AI SDK et 2 268 ms pour Pi. Le p95 total vaut 882 ms contre 2 604 ms. À 100 chats
chauds, le premier token vaut 777 ms contre 2 392 ms et le total 1 191 ms contre 2 762 ms. La forme
T confirme donc la régression du chemin Pi sans introduire de perte d'outil ou de persistance.

## Distributions à 100 chats

Les deux distributions supplémentaires terminent 4 000 conversations sans erreur ni contamination.
Le tableau compare les profils chauds S avec la distribution de référence.

| Distribution               | Moteur | p95 premier token, ms | p95 total, ms | Chats par seconde | Pic RSS, Mio |
| -------------------------- | ------ | --------------------: | ------------: | ----------------: | -----------: |
| 100 organisations, 1 chat  | AI SDK |                   413 |           877 |            107,43 |        904,9 |
| 100 organisations, 1 chat  | Pi     |                 2 172 |         3 555 |             27,09 |        705,4 |
| 10 organisations, 10 chats | AI SDK |                   745 |         1 162 |             76,52 |        512,1 |
| 10 organisations, 10 chats | Pi     |                 3 961 |         5 001 |             19,68 |        547,5 |
| 1 organisation, 100 chats  | AI SDK |                   492 |         1 062 |             89,78 |        475,0 |
| 1 organisation, 100 chats  | Pi     |                 3 353 |         5 333 |             18,39 |        550,8 |

Le partage d'organisation ne révèle aucune fuite d'identité, mais il ne réduit pas la contention Pi.
Les deux distributions partagées ont au contraire un débit Pi inférieur à 20 chats par seconde.

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

Sur les 280 observations principales :

| Mesure                                   |                       Résultat |
| ---------------------------------------- | -----------------------------: |
| Conversations demandées et terminées     |              18 260 sur 18 260 |
| 429                                      |                              0 |
| Erreurs serveur                          |                              0 |
| Streams incomplets                       |                              0 |
| Marqueurs incorrects                     |                              0 |
| Appels modèle                            |                         22 740 |
| Appels d'outil                           |                          4 480 |
| Tokens d'entrée                          |                      3 054 080 |
| Tokens de sortie                         |                        656 000 |
| Messages persistés                       |                         37 220 |
| Parties structurées persistées           |                         76 665 |
| Lignes d'usage persistées                |                         23 250 |
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

Mistral accepte les vagues réelles jusqu'à 100 sans 429 dans cette campagne. Cela décrit la clé et
la fenêtre testées, pas une garantie de capacité permanente. Codex et Claude Code acceptent 30
conversations simultanées sans refus. Leur capacité à 60 reste inconnue et n'est pas testée sans
confirmation de politique. OpenRouter n'a pas été utilisé, car Mistral suffit à confirmer la
direction du résultat.

### Limite de politique Appstrate

Le plafond Pi par défaut est 64. Les tests vérifient le 429 RFC 9457, `Retry-After`, la libération du
slot à la fermeture et l'absence de persistance du message utilisateur refusé. Une vague contrôlée
à 100 avec ce plafond a admis exactement 64 conversations et produit 36 réponses 429, zéro erreur,
zéro stream incomplet et zéro message pour une session refusée. Elle a effectué 64 appels modèle et
persisté les 64 paires utilisateur et assistant attendues, plus le tour de continuité. Le banc
moteur a utilisé 128 uniquement pour observer la capacité brute à 100.

### Limite cloud

Le nombre de réplicas, leur mémoire et CPU, l'autoscaling, les redémarrages, la concurrence p99 et
la distribution réelle des tokens et outils ne sont pas disponibles. Aucun chiffre local ne doit
être présenté comme capacité cloud.

## Travail local encore nécessaire

1. Diagnostiquer la contention de boucle événementielle Pi observée dans le banc contrôlé et le
   surcoût réel restant à 60, 64 et 100.
2. Corriger ou documenter la conversion AI SDK d'un historique contenant du raisonnement avant un
   nouvel essai H réel.
3. Fermer l'interface d'extension qui bloque Chrome Beta, puis terminer le contrôle visuel d'un
   chat AI SDK et d'un chat Pi relus depuis leur session persistée.
4. N'utiliser OpenRouter Free que si une correction change la conclusion Mistral et nécessite une
   confirmation indépendante.
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
bun scripts/chat-engine-performance.ts controlled --forms=T --profiles=cold,warm --concurrency=60,64,100 --repetitions=5 --recovery-ms=0 --output=artifacts/chat-engine-performance/controlled-t-high-r5
bun scripts/chat-engine-performance.ts controlled --forms=S --profiles=cold,warm --concurrency=100 --organizations=10 --repetitions=5 --recovery-ms=0 --output=artifacts/chat-engine-performance/controlled-s-c100-o10-r5
bun scripts/chat-engine-performance.ts controlled --forms=S --profiles=cold,warm --concurrency=100 --organizations=1 --repetitions=5 --recovery-ms=0 --output=artifacts/chat-engine-performance/controlled-s-c100-o1-r5
bun scripts/chat-engine-performance.ts controlled --engines=pi --forms=S --profiles=cold --concurrency=100 --organizations=100 --pi-cap=64 --repetitions=1 --recovery-ms=0 --output=artifacts/chat-engine-performance/policy-pi-c100-cap64
bun scripts/chat-engine-performance.ts controlled --forms=S --profiles=cold,warm --concurrency=60,64,100 --repetitions=1 --recovery-ms=120000 --output=artifacts/chat-engine-performance/controlled-s-recovery-120s

bun scripts/chat-pi-fixed-load.ts --repetitions=10 --output=artifacts/chat-engine-performance/fixed-load-r10 --summary-output=docs/architecture/performance-results/2026-08-18-pi-fixed-load.v1.json

bun scripts/chat-engine-performance-report.ts --input=artifacts/chat-engine-performance/controlled-s-low-r5,artifacts/chat-engine-performance/controlled-s-high-r5,artifacts/chat-engine-performance/controlled-h-high-r5,artifacts/chat-engine-performance/controlled-t-high-r5,artifacts/chat-engine-performance/controlled-s-c100-o10-r5,artifacts/chat-engine-performance/controlled-s-c100-o1-r5 --output=docs/architecture/performance-results/2026-08-18-controlled-summary.v1.json
bun scripts/chat-engine-performance-report.ts --input=artifacts/chat-engine-performance/controlled-s-recovery-120s --output=docs/architecture/performance-results/2026-08-18-controlled-recovery.v1.json

TEST_TIER=0 bun test packages/module-chat/test/pi-chat-concurrency.test.ts packages/module-chat/test/chat-stream-handler.test.ts packages/module-chat/test/pi-chat-engine-selection.test.ts packages/module-chat/test/pi-chat-model-binding.test.ts
```

Comparatif Mistral réel :

```bash
bun scripts/chat-engine-performance.ts mistral --env-file=/chemin/absolu/mistral.env --model=mistral-small-2603 --forms=S --profiles=cold,warm --concurrency=60,64,100 --repetitions=3 --recovery-ms=0 --output=artifacts/chat-engine-performance/mistral-real
bun scripts/chat-engine-performance.ts mistral --env-file=/chemin/absolu/mistral.env --model=mistral-small-2603 --forms=S --profiles=warm --concurrency=60,64,100 --repetitions=1 --recovery-ms=120000 --output=artifacts/chat-engine-performance/mistral-real-recovery
```

Le modèle épinglé `mistral-small-2603` correspond à Mistral Small 4 v26.03 et expose officiellement
Chat Completions et Function Calling, voir la
[fiche modèle Mistral](https://docs.mistral.ai/models/model-cards/mistral-small-4-0-26-03).

Le fichier d'environnement doit contenir uniquement la clé attendue ou, au minimum, le harness ne
lit explicitement que `MISTRAL_API_KEY`. La clé n'est jamais copiée dans les observations.

Abonnements Pi réels, avec un fichier local contenant `DATABASE_URL` et
`CONNECTION_ENCRYPTION_KEY` pour la base où les abonnements sont déjà connectés :

```bash
bun scripts/chat-engine-performance.ts subscription --provider=codex --model=gpt-5.6-luna --env-file=/chemin/absolu/subscriptions.env --forms=S --profiles=cold --concurrency=1,10,30 --repetitions=1 --recovery-ms=120000 --output=artifacts/chat-engine-performance/subscription-codex
bun scripts/chat-engine-performance.ts subscription --provider=claude-code --model=claude-haiku-4-5 --env-file=/chemin/absolu/subscriptions.env --forms=S --profiles=cold --concurrency=1,10,30 --repetitions=1 --recovery-ms=120000 --output=artifacts/chat-engine-performance/subscription-claude
```

Publication des observations brutes sans leurs bases PGlite :

```bash
bun scripts/chat-engine-performance-publish.ts --input=artifacts/chat-engine-performance/mistral-real,artifacts/chat-engine-performance/subscription-codex,artifacts/chat-engine-performance/subscription-claude --output=docs/architecture/performance-results/raw/2026-08-18-real
```

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
- Synthèse contrôlée et références vers 280 observations : [2026-08-18-controlled-summary.v1.json](./performance-results/2026-08-18-controlled-summary.v1.json)
- Récupération mémoire et références vers 12 observations : [2026-08-18-controlled-recovery.v1.json](./performance-results/2026-08-18-controlled-recovery.v1.json)
- Coût fixe Pi et références vers 10 observations : [2026-08-18-pi-fixed-load.v1.json](./performance-results/2026-08-18-pi-fixed-load.v1.json)
- Politique Pi à 64 et référence vers l'observation à 100 : [2026-08-18-policy-cap64.v1.json](./performance-results/2026-08-18-policy-cap64.v1.json)
- Mistral S froid, trois répétitions : [2026-08-18-mistral-cold-summary.v1.json](./performance-results/2026-08-18-mistral-cold-summary.v1.json)
- Mistral principal, dont S chaud et l'anomalie H : [2026-08-18-mistral-main-summary.v1.json](./performance-results/2026-08-18-mistral-main-summary.v1.json)
- Récupération Mistral à 30, 60 et 120 secondes : [2026-08-18-mistral-recovery.v1.json](./performance-results/2026-08-18-mistral-recovery.v1.json)
- Abonnements Pi Codex et Claude Code : [2026-08-18-pi-subscriptions.v1.json](./performance-results/2026-08-18-pi-subscriptions.v1.json)
- Index et sommes SHA-256 de 65 observations réelles : [index.v1.json](./performance-results/raw/2026-08-18-real/index.v1.json)

Les 65 observations réelles sélectionnées sont désormais versionnées sans leur base PGlite. Leur
`schemaVersion` vaut 1. Aucun secret ni contenu utilisateur réel n'y figure. Les autres observations
exploratoires et les bases restent sous `artifacts/chat-engine-performance/`, hors Git.

## Entrée du journal de décision RFC

**18 août 2026, validation locale contrôlée et réelle : NO GO avant canary.** Le banc déterministe a
terminé 18 260 conversations mesurées sans erreur fonctionnelle, perte de persistance ni
contamination, mais Pi échoue aux seuils de non-infériorité de latence et débit à 60, 64 et 100. Le
comparatif Mistral réel S a ajouté 2 688 conversations principales valides. À 100 organisations
chaudes, Pi se rapproche des seuils de latence, mais son débit reste à 85,2 % de celui d'AI SDK,
sous le minimum de 90 %. Mistral n'a produit aucun 429 jusqu'à 100. Les essais Pi uniquement Codex
et Claude Code passent à 1, 10 et 30, sans autoriser une comparaison avec AI SDK ni un test à 60.
La récupération mémoire locale passe, mais la pente marginale et la capacité cloud restent
inconnues. Le contrôle Chrome Beta est encore bloqué par une interface d'extension ouverte. AI SDK
reste déployable. Aucun canary, aucune migration de trafic et aucune suppression d'AI SDK ne sont
autorisés à ce stade.

La RFC source se trouve hors du worktree autorisé. Cette entrée est donc fournie ici, prête à être
reportée dans son journal sans modifier le satellite externe.
