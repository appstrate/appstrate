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

La migration de contrôle vers Pi 0.84.2 est validée, puis la matrice déterministe réduite a été
rejouée sur S chaud à 60, 64 et 100, trois répétitions appariées. Les 1 344 conversations ont terminé
et tous les invariants fonctionnels passent. Pi échoue encore aux trois seuils à chaque niveau. Son
p95 au premier token vaut 4,53 à 5,57 fois celui d'AI SDK, sa durée totale 2,79 à 3,23 fois celle
d'AI SDK et son débit seulement 32,2 % à 37,2 % du débit AI SDK. La mise à niveau ne justifie donc
pas de modifier la décision locale.

L'instrumentation du cycle de vie a ensuite isolé une anomalie Appstrate : chaque tour demandait à
Pi un rafraîchissement complet du catalogue alors que le modèle était déjà résolu. Sa suppression
fait tomber la création du runtime sous 1 ms. Le nouveau rejeu réduit ajoute 1 344 conversations
valides. Le gain de premier token Pi est visible à 60 et 64, environ 0,27 et 0,29 seconde au p95,
mais la variance locale ne permet pas de revendiquer un gain à 100. Le coût dominant restant se
situe après l'appel `prompt()`, avant et après l'arrivée chez le fournisseur contrôlé. Le NO GO est
donc maintenu.

L'instrumentation interne appariée ferme maintenant ce dernier angle mort. À 10 chats, le premier
token médian vaut 113 ms pour AI SDK et 363 ms pour Pi, soit environ 250 ms perceptibles de plus.
Sur Pi, 158 à 202 ms se passent avant l'entrée dans le moteur, dans le chemin Appstrate et PGlite.
La préparation propre à Pi prend 20 à 23 ms, dont 17 à 19 ms de chargement de ressources. Le clone
et la conversion du contexte prennent ensuite 21 à 31 ms. L'attente du fournisseur synthétique
sous contention locale prend 98 à 132 ms. Une fois le premier texte produit, son adaptation et sa
livraison au client prennent seulement 0,05 à 0,15 ms. Le mapper UI n'est donc pas en cause.

Ce diagnostic a aussi trouvé une seconde synchronisation redondante propre à Appstrate. Le
placeholder d'authentification `proxy` déclenchait une recomposition et des vérifications de
disponibilité Pi à chaque conversation. Son enregistrement synchrone fait passer cette étape de 24 à
36 ms à environ 0,1 à 0,2 ms à concurrence 10. Les credentials OAuth réels de Codex et Claude Code
gardent leur synchronisation complète. Cette correction réduit un coût certain, sans suffire à
lever le NO GO aux fortes concurrences déjà mesurées.

Un smoke Mistral à concurrence 1 a terminé les quatre cellules AI SDK et Pi, froides et chaudes. À
chaud, Pi a livré le premier token en 617 ms et terminé en 669 ms, contre 627 ms et 690 ms pour AI
SDK. Claude Code a terminé en 7 068 ms. Le premier essai Codex a révélé un mapping fournisseur hérité
de Pi 0.73. Après correction vers le fournisseur natif `openai-codex` et préservation des corps zstd
dans le sidecar OAuth, Codex a terminé en 2 658 ms, avec premier token à 2 473 ms, un appel modèle,
zéro erreur et persistance valide.

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
a atteint la page du port 3400. Le contrôle a été retenté le 19 août après redémarrage de la stack :
l'inscription locale s'affiche et les champs synthétiques peuvent être remplis, mais le clic final
reste bloqué par une interface d'extension Chrome ouverte. Aucun autre navigateur n'a été utilisé.

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

## Rejeu réduit avec Pi 0.84.2

Le rejeu du 19 août reprend le cœur décisionnel déterministe avec le même fournisseur, la même forme
S chaude, une organisation synthétique par conversation et trois répétitions appariées.

| Concurrence | Moteur | p95 premier token, ms | p95 total, ms | Chats par seconde | Pic RSS, Mio |
| ----------: | ------ | --------------------: | ------------: | ----------------: | -----------: |
|          60 | AI SDK |                   436 |         1 004 |             56,50 |        727,7 |
|          60 | Pi     |                 2 431 |         2 800 |             21,04 |        747,9 |
|          64 | AI SDK |                   578 |         1 061 |             57,73 |        694,0 |
|          64 | Pi     |                 2 619 |         2 994 |             21,02 |        804,7 |
|         100 | AI SDK |                   753 |         1 470 |             64,39 |        805,8 |
|         100 | Pi     |                 3 948 |         4 748 |             20,71 |        839,5 |

| Concurrence | Ratio Pi premier token | Ratio Pi total | Débit Pi sur AI SDK |
| ----------: | ---------------------: | -------------: | ------------------: |
|          60 |                   5,57 |           2,79 |              37,2 % |
|          64 |                   4,53 |           2,82 |              36,4 % |
|         100 |                   5,24 |           3,23 |              32,2 % |

Les 1 344 conversations correspondent à 1 344 appels modèle, 172 032 tokens d'entrée et 43 008
tokens de sortie. Il n'y a eu aucun 429, aucune erreur serveur, aucun stream incomplet et aucun
marqueur incorrect. Les messages, parties structurées et lignes d'usage sont persistés. La
continuité de session et l'isolation entre organisations et utilisateurs passent dans les 18
observations.

Le premier lancement a détecté un défaut du harness après la mise à niveau : le fournisseur
déterministe simulait uniquement Chat Completions, tandis que le fournisseur OpenAI intégré à Pi
0.84 utilise Responses par défaut. Appstrate enregistre désormais explicitement l'API déclarée par
le modèle proxy quand le fournisseur Pi intégré ne la supporte pas. Le repro minimal à une
conversation et les 18 cellules passent après cette correction. Ce défaut ne concernait pas les
smoke tests Mistral, Codex ou Claude, qui utilisent leurs transports natifs.

La variabilité locale reste forte, notamment pour AI SDK. Le rejeu ne démontre donc pas une tendance
fine entre Pi 0.73 et Pi 0.84. Il démontre en revanche que Pi 0.84 échoue encore largement aux seuils
de non-infériorité dans le banc qui isole le coût du moteur. Le comparatif Mistral complet à 60, 64
et 100 n'a pas été rejoué après la mise à niveau, car la clé temporaire n'est plus disponible dans
l'environnement. Le smoke Mistral post-migration à concurrence 1 reste valide.

## Diagnostic du cycle de vie et rafraîchissement du runtime

Le diagnostic du 19 août mesure séparément MCP, chargement SDK, projection de session, création du
runtime, credential, ressources et création de session. Avant correction, à concurrence 10,
`ModelRuntime.create()` coûtait 156 ms en médiane et 290 ms au p95, contre 5 à 10 ms à concurrence

1. Le credential ne coûtait qu'environ 2,5 ms. La cause était le rafraîchissement global déclenché
   par défaut lors de chaque création concurrente.

Appstrate passe maintenant `refreshOnCreate: false`. Cette option est sûre dans ce flux : le modèle
concret est résolu avant Pi, le réseau catalogue est déjà désactivé et l'installation du credential
resynchronise ensuite le seul fournisseur ciblé. Aucun runtime ni credential n'est partagé entre
utilisateurs. Après correction, la création du runtime reste sous 1 ms en médiane jusqu'à 100
conversations.

Le rejeu publiable utilise S chaud, trois répétitions appariées et le commit `3a1bb53d`.

| Concurrence | Moteur | p95 premier token, ms | p95 total, ms | Chats par seconde | Pic RSS, Mio |
| ----------: | ------ | --------------------: | ------------: | ----------------: | -----------: |
|          60 | AI SDK |                   368 |           869 |             63,57 |        713,6 |
|          60 | Pi     |                 2 164 |         2 580 |             22,63 |        794,3 |
|          64 | AI SDK |                   688 |         1 543 |             40,17 |        734,8 |
|          64 | Pi     |                 2 331 |         2 685 |             23,34 |        754,3 |
|         100 | AI SDK |                   837 |         1 614 |             59,34 |        824,1 |
|         100 | Pi     |                 4 162 |         4 914 |             19,96 |        829,0 |

En temps humain, l'écart de premier token est donc d'environ 1,80 seconde à 60, 1,64 seconde à 64
et 3,33 secondes à 100. Le débit Pi représente respectivement 35,6 %, 58,1 % et 33,6 % du débit AI
SDK. Les 1 344 conversations, 1 344 appels modèle, 172 032 tokens d'entrée et 43 008 tokens de
sortie passent sans 429, erreur, stream incomplet, contamination ni défaut de persistance.

Le harness horodate aussi la frontière fournisseur, après lecture de la requête contrôlée et avant
l'écriture d'usage synthétique. Sur les répétitions médianes Pi, le fournisseur est atteint vers
1,25 seconde à 60, 1,41 seconde à 64 et 2,29 secondes à 100. La préparation Pi explicitement
instrumentée ne représente qu'environ 80 à 90 ms. Le résidu principal se trouve donc dans la boucle
Pi déclenchée par `prompt()`, puis dans le retour du stream sous contention locale. Il ne vient ni
du chargement dynamique du SDK, ni de la projection de session, ni de la création de session, ni
du credential. Cette mesure prouve un coût moteur local. Elle ne permet pas encore d'attribuer ce
résidu à une fonction Pi unique sans instrumentation interne supplémentaire.

## Diagnostic interne apparié de Pi

Le rejeu du 19 août au commit `d2aa97ef` utilise S chaud à 1 et 10 chats, trois répétitions par
moteur. Chaque timeline relie les timestamps d'une même conversation. Les durées sont donc
additives, contrairement à une soustraction de p50 calculés sur des tours différents. Les douze
observations brutes sont versionnées avec leurs sommes SHA-256.

| Concurrence | Moteur | Premier token médian, ms | Plage des trois répétitions, ms |
| ----------: | ------ | -----------------------: | ------------------------------: |
|           1 | AI SDK |                       41 |                         41 à 44 |
|           1 | Pi     |                       75 |                         69 à 84 |
|          10 | AI SDK |                      113 |                        95 à 138 |
|          10 | Pi     |                      363 |                       360 à 417 |

Pour Pi, les chronologies représentatives donnent les plages suivantes.

| Segment apparié                       | 1 chat, ms | 10 chats, ms | Attribution                            |
| ------------------------------------- | ---------: | -----------: | -------------------------------------- |
| Requête vers entrée moteur            |     6 à 14 |    158 à 202 | Appstrate et PGlite local, avant Pi    |
| Entrée moteur vers `prompt()`         |    25 à 35 |      20 à 23 | Préparation Pi                         |
| Dont chargement de ressources         |    22 à 29 |      17 à 19 | Coût fixe Pi, accès disque synchrones  |
| Credential proxy                      |        0,2 |    0,1 à 0,2 | Fast path Appstrate corrigé            |
| Clone du contexte                     |      0 à 1 |       6 à 11 | Pi, amplifié par la concurrence locale |
| Conversion et préparation des headers |      0 à 1 |      15 à 20 | Pi, avant la requête fournisseur       |
| Attente du fournisseur contrôlé       |          2 |     98 à 132 | PGlite et ordonnanceur du banc local   |
| Stream fournisseur vers premier texte |    31 à 38 |      28 à 32 | 25 ms simulés, puis parsing Pi         |
| Premier texte Pi vers token client    |       0,12 |  0,05 à 0,15 | Mapper et protocole UI, négligeables   |

Le coût directement mesuré dans Pi à concurrence 1 est dominé par les 22 à 29 ms du
`DefaultResourceLoader`. À concurrence 10, le clone et la conversion ajoutent environ 21 à 31 ms.
Le chemin Appstrate avant moteur devient toutefois plus coûteux pour la branche Pi, alors que le
moteur n'a pas encore commencé. Dans cette base isolée, dix écritures concurrentes de message et
d'état de stream se sérialisent dans PGlite. Ce temps ne doit pas être présenté comme un coût de la
bibliothèque Pi ni extrapolé à PostgreSQL cloud.

Une ablation a supprimé uniquement l'écriture `llm_usage` du fournisseur déterministe. L'attente
entre requête et réponse fournisseur est tombée de 105 à 152 ms à 8 à 9 ms à concurrence 10. Le
temps s'est ensuite déplacé vers la lecture concurrente des streams, sans amélioration stable du
premier token total. Le faux fournisseur, PGlite et l'ordonnanceur forment donc un goulot local qui
redistribue l'attente. Cette ablation n'est pas une configuration de validation fonctionnelle, car
les campagnes officielles conservent toujours la persistance d'usage.

Le profil CPU limité exactement à la vague de dix chats couvre 565 ms échantillonnés. Les appels
fichier synchrones `realpathSync`, `readFileSync`, `readdirSync` et `existsSync` représentent 18,4 %
du CPU propre. Le parsing de lignes SSE OpenAI en représente environ 8 %, `JSON.stringify` 4,5 %,
le clone d'objets 3,7 % et PGlite 3,7 %. Ce profil confirme la nature composite de l'écart : coût
fixe du chargeur Pi, sérialisation et parsing Pi, puis contention du banc Appstrate local.

Conclusion : Pi fonctionne, persiste correctement et son mapper n'ajoute pratiquement aucune
latence. Une partie du surcoût venait bien de notre intégration et deux synchronisations redondantes
ont été supprimées. Il reste un coût fixe Pi mesurable et une amplification locale composite. Les
écarts de plusieurs secondes observés à 60, 64 et 100 ne peuvent pas être attribués uniquement à Pi
à partir de PGlite. Ils restent néanmoins bloquants pour un canary local tant que le même protocole
n'a pas été rejoué sur le profil PostgreSQL et réplica cloud réel.

## Diagnostic ciblé du chargeur de ressources du chat

Un profil CPU limité à la vague de 30 chats a identifié la principale amplification locale.
`DefaultResourceLoader.reload()` parcourait à chaque tour les skills, extensions et fichiers de
contexte locaux, notamment `~/.agents/skills`, avant d'écarter les ressources que le chat n'utilise
pas. Les piles chaudes contenaient `realpathSync`, `readFileSync`, `readdirSync`, `statSync` et
`existsSync`. Ces accès synchrones représentaient 47,7 % des échantillons de la vague Pi avant
correction.

Le chat utilise maintenant une politique de ressources explicite : prompt fourni par Appstrate et
extensions inline du tour uniquement. Les skills et outils restent fournis par le MCP Appstrate.
Le runtime Pi conserve sa découverte complète de ressources. Aucun client MCP, credential, état de
session, historique ou résultat d'outil n'est partagé entre conversations.

À 30 chats chauds, sur une répétition contrôlée appariée, le p95 du premier token Pi passe de
1 243 ms à 271 ms et le débit de 18,9 à 60,4 chats par seconde. AI SDK mesure 237 ms et 62,2 chats
par seconde. Pi atteint donc 97,1 % de son débit, avec un écart de 34 ms au premier token. Le
rechargement des ressources Pi passe de 53,2 ms à 2,3 ms au p95.

Une confirmation légère, une répétition par moteur et une organisation par chat, donne :

| Concurrence | Moteur | p95 premier token, ms | p95 total, ms | Chats par seconde |
| ----------: | ------ | --------------------: | ------------: | ----------------: |
|          60 | AI SDK |                   289 |           562 |             99,32 |
|          60 | Pi     |                   498 |           755 |             76,11 |
|         100 | AI SDK |                   560 |           954 |             99,69 |
|         100 | Pi     |                   733 |         1 108 |             86,06 |

À 100, l'écart absolu du premier token tombe à 173 ms et le débit Pi atteint 86,3 % de celui d'AI
SDK. À 60, Pi reste en retrait de 209 ms et son débit atteint 76,6 %. Une seule répétition ne remplace
pas la matrice statistique, mais suffit à confirmer que la découverte locale était causale.

La paire Mistral chaude à 60 ajoute 120 conversations réelles sans 429, erreur, stream incomplet ou
défaut d'isolation. Son unique répétition mesure 4 663 ms pour AI SDK et 6 467 ms pour Pi au premier
token. Le débit Pi est légèrement supérieur, 8,70 contre 8,19 chats par seconde. Cette divergence
entre latence de queue et débit confirme une forte variance fournisseur. Elle valide la compatibilité
du correctif, pas un nouveau ratio de performance réel.

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

1. Mesurer séparément la découverte du catalogue MCP et tester un snapshot immuable des définitions,
   sans partager client, autorisation, session, historique ou résultats entre conversations.
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

bun scripts/chat-engine-performance.ts controlled --forms=S --profiles=warm --concurrency=60,64,100 --repetitions=3 --recovery-ms=0 --output=artifacts/chat-engine-performance/pi-0842-controlled-reduced-r3-49b4a641
bun scripts/chat-engine-performance-report.ts --input=artifacts/chat-engine-performance/pi-0842-controlled-reduced-r3-49b4a641 --output=docs/architecture/performance-results/2026-08-19-pi-0842-controlled-reduced.v1.json
bun scripts/chat-engine-performance-publish.ts --input=artifacts/chat-engine-performance/pi-0842-controlled-reduced-r3-49b4a641 --output=docs/architecture/performance-results/raw/2026-08-19-pi-0842-controlled-reduced

bun scripts/chat-engine-performance.ts controlled --forms=S --profiles=warm --concurrency=60,64,100 --repetitions=3 --recovery-ms=0 --output=artifacts/chat-engine-performance/pi-runtime-refresh-off-reduced-r3-3a1bb53d
bun scripts/chat-engine-performance-report.ts --input=artifacts/chat-engine-performance/pi-runtime-refresh-off-reduced-r3-3a1bb53d --output=docs/architecture/performance-results/2026-08-19-pi-runtime-refresh-off-controlled-reduced.v1.json
bun scripts/chat-engine-performance-publish.ts --input=artifacts/chat-engine-performance/pi-runtime-refresh-off-reduced-r3-3a1bb53d --output=docs/architecture/performance-results/raw/2026-08-19-pi-runtime-refresh-off-controlled-reduced

bun scripts/chat-engine-performance.ts controlled --engines=ai-sdk,pi --forms=S --profiles=warm --concurrency=1,10 --repetitions=3 --recovery-ms=0 --output=artifacts/chat-engine-performance/pi-internal-final-c1-c10-r3-d2aa97ef
bun scripts/chat-engine-performance-publish.ts --input=artifacts/chat-engine-performance/pi-internal-final-c1-c10-r3-d2aa97ef --output=docs/architecture/performance-results/raw/2026-08-19-pi-internal-diagnostics

bun scripts/chat-engine-performance.ts controlled --engines=pi --forms=S --profiles=warm --concurrency=10 --repetitions=1 --recovery-ms=0 --cpu-profile=true --output=artifacts/chat-engine-performance/cpu-profile-reproduction-c10
bun scripts/chat-engine-cpu-profile.ts --profile=artifacts/chat-engine-performance/cpu-profile-reproduction-c10/cpu-profiles/pi-S-warm-c10-o10-r1.cpuprofile --observation=artifacts/chat-engine-performance/cpu-profile-reproduction-c10/pi-S-warm-c10-o10-r1.json --output=artifacts/chat-engine-performance/cpu-profile-reproduction-c10/pi-S-warm-c10-o10-r1-wave-profile.v1.json --limit=30

bun scripts/chat-engine-performance.ts controlled --engines=ai-sdk,pi --forms=S --profiles=warm --concurrency=30 --repetitions=1 --recovery-ms=0 --output=artifacts/chat-engine-performance/resource-policy-c30-r1
bun scripts/chat-engine-performance.ts controlled --engines=ai-sdk,pi --forms=S --profiles=warm --concurrency=60,100 --repetitions=1 --recovery-ms=0 --output=artifacts/chat-engine-performance/resource-policy-c60-c100-r1
bun scripts/chat-engine-performance.ts mistral --engines=ai-sdk,pi --env-file=/chemin/absolu/mistral.env --model=mistral-small-2603 --forms=S --profiles=warm --concurrency=60 --repetitions=1 --recovery-ms=0 --output=artifacts/chat-engine-performance/resource-policy-mistral-c60-r1

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
- Smoke Pi 0.84.2, Mistral, Codex et Claude Code : [2026-08-18-pi-0842-smoke.v1.json](./performance-results/2026-08-18-pi-0842-smoke.v1.json)
- Rejeu contrôlé réduit Pi 0.84.2 : [2026-08-19-pi-0842-controlled-reduced.v1.json](./performance-results/2026-08-19-pi-0842-controlled-reduced.v1.json)
- Index et sommes SHA-256 des 18 observations du rejeu : [index.v1.json](./performance-results/raw/2026-08-19-pi-0842-controlled-reduced/index.v1.json)
- Rejeu après suppression du rafraîchissement runtime redondant : [2026-08-19-pi-runtime-refresh-off-controlled-reduced.v1.json](./performance-results/2026-08-19-pi-runtime-refresh-off-controlled-reduced.v1.json)
- Index et sommes SHA-256 des 18 observations instrumentées : [index.v1.json](./performance-results/raw/2026-08-19-pi-runtime-refresh-off-controlled-reduced/index.v1.json)
- Index et sommes SHA-256 des 12 observations internes appariées : [index.v1.json](./performance-results/raw/2026-08-19-pi-internal-diagnostics/index.v1.json)
- Diagnostic du chargeur de ressources du chat : [2026-08-19-pi-chat-resource-policy.v1.json](./performance-results/2026-08-19-pi-chat-resource-policy.v1.json)
- Profils CPU ciblés : [avant](./performance-results/2026-08-19-pi-chat-resource-scan-c30-before.cpu.v1.json) et [après](./performance-results/2026-08-19-pi-chat-resource-scan-c30-after.cpu.v1.json)
- Index et sommes SHA-256 des neuf observations ciblées : [index.v1.json](./performance-results/raw/2026-08-19-pi-chat-resource-policy/index.v1.json)
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

La RFC source se trouve hors du worktree autorisé. Ces entrées sont donc fournies ici, prêtes à être
reportées dans son journal sans modifier le satellite externe.

**18 août 2026, mise à niveau Pi 0.84.2 : validation locale réussie.** Le namespace npm passe à
`@earendil-works`. Appstrate utilise désormais `ModelRuntime`, le hook officiel
`before_provider_headers` et le transport Mistral HTTP natif. Les smoke tests réels Mistral et Claude
Code passent. Une incompatibilité Codex détectée pendant la validation a été corrigée en séparant le
fournisseur `openai-codex` du fournisseur `openai` et en conservant byte pour byte les corps zstd dans
le sidecar OAuth. Le rejeu Codex réel passe ensuite sans erreur. Cette validation ne remplace pas la
matrice à 60, 64 et 100, ne modifie pas la décision cloud et n'autorise toujours aucun canary.

**19 août 2026, rejeu déterministe réduit Pi 0.84.2 : NO GO maintenu.** La forme S chaude a été
rejouée à 60, 64 et 100, trois répétitions par moteur. Les 1 344 conversations et tous les invariants
fonctionnels passent, mais le débit Pi ne représente que 37,2 %, 36,4 % et 32,2 % du débit AI SDK.
Pi échoue aussi aux seuils de premier token et de durée totale à chaque niveau. Le premier lancement
a révélé puis permis de corriger un défaut de compatibilité du harness avec la sélection d'API de Pi
0.84. Le comparatif Mistral complet post-migration reste à rejouer lorsqu'une clé dédiée sera de
nouveau injectée. La capacité cloud reste inconnue. Aucun canary, aucune migration de trafic et
aucune suppression du moteur AI SDK ne sont autorisés.

**19 août 2026, diagnostic du runtime Pi : NO GO maintenu après correction locale.** Le harness
localise une contention certaine dans le rafraîchissement complet effectué par
`ModelRuntime.create()` à chaque tour. Appstrate le désactive, sans partager runtime ni credential,
car le modèle est déjà résolu et le fournisseur ciblé est resynchronisé ensuite. La création du
runtime tombe sous 1 ms. Un rejeu apparié de 1 344 conversations à 60, 64 et 100 passe tous les
invariants. Le gain de premier token Pi est d'environ 0,27 seconde à 60 et 0,29 seconde à 64 par
rapport au rejeu précédent, sans gain démontrable à 100 en raison de la variance. Pi reste plus lent
d'environ 1,80, 1,64 et 3,33 secondes au p95 du premier token. L'horodatage de la frontière
fournisseur place le résidu dans la boucle Pi après `prompt()` et dans le retour du stream sous
contention locale. La capacité cloud reste inconnue. Aucun canary, aucune migration de trafic et
aucune suppression du moteur AI SDK ne sont autorisés.

**19 août 2026, diagnostic interne apparié Pi : NO GO maintenu, attribution affinée.** Douze
observations à 1 et 10 chats relient chaque étape au même tour. À 10 chats, le premier token médian
vaut 113 ms pour AI SDK et 363 ms pour Pi. Environ 158 à 202 ms précèdent l'entrée dans Pi et
appartiennent au chemin Appstrate avec PGlite. Pi consomme ensuite 20 à 23 ms de préparation, puis
21 à 31 ms de clone et conversion du contexte. Le faux fournisseur et sa persistance locale
absorbent 98 à 132 ms. Le mapper Pi vers le client ne prend que 0,05 à 0,15 ms. Une seconde
synchronisation Appstrate redondante du placeholder `proxy` est corrigée, ce qui ramène le setup du
credential de 24 à 36 ms à environ 0,1 à 0,2 ms sans modifier le traitement OAuth de Codex ou Claude
Code. Le profil CPU confirme 18,4 % d'accès fichier synchrones dans la vague Pi. Pi fonctionne, mais
le coût fixe du chargeur et l'amplification composite locale restent mesurables. Les résultats
PGlite ne déterminent pas la capacité PostgreSQL cloud. Aucun canary, aucune migration de trafic et
aucune suppression d'AI SDK ne sont autorisés.

**19 août 2026, politique de ressources du chat : contention principale corrigée.** Le profil CPU
attribue 47,7 % de la vague Pi à la découverte synchrone de ressources locales qui ne font pas partie
de la politique du chat. Appstrate désactive cette découverte dans le chat uniquement. Les skills et
outils restent servis par le MCP Appstrate, tandis que le runtime Pi conserve son comportement
complet. À 30 chats, le p95 du premier token Pi passe de 1 243 à 271 ms et son débit atteint 97,1 %
de celui d'AI SDK. Une confirmation légère à 60 et 100 réduit l'écart absolu du premier token à 209
et 173 ms, mais le débit Pi reste à 76,6 % et 86,3 %. Une paire Mistral à 60 passe tous les invariants,
avec une variance fournisseur trop forte pour conclure sur un seul point. La correction rend Pi
nettement plus crédible pour l'unification, sans établir la capacité cloud ni autoriser une migration
de trafic ou la suppression d'AI SDK.
