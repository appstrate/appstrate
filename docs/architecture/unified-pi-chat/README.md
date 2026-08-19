# Unified Pi Chat, état canonique de la validation

Dernière mise à jour : 19 août 2026

Branche : `feat/chat-pi-unified-engine-phase4`

Destinataire : Pierre

Ce fichier est l'unique documentation narrative du chantier de performance Unified Pi Chat. Il
remplace les anciens comptes rendus séparés. Une synthèse JSON compacte et les preuves
fonctionnelles restent versionnées. Les observations brutes sont reproductibles par le harness,
mais ne font pas partie du diff de revue.

## Conclusion actuelle

Pi est fonctionnel et suffisamment rapide pour poursuivre l'unification et les essais internes.
Il n'est pas encore possible de conclure sur la capacité Appstrate Cloud, car les ressources des
réplicas, l'autoscaling et la concurrence réelle ne sont pas disponibles.

La principale anomalie locale a été expliquée et corrigée. Le chat demandait à Pi de parcourir les
skills, extensions et fichiers de contexte locaux à chaque tour, alors que sa politique autorise
uniquement le MCP Appstrate. La désactivation de cette découverte dans le chat fait passer le p95
du premier token Pi de 1 243 à 267 ms à 30 chats contrôlés. Le runtime Pi conserve sa découverte
complète et le chat conserve le même noyau Pi.

Après correction, le comparatif Mistral chaud à 60 chats mesure 2 771 ms pour AI SDK et 2 803 ms
pour Pi au premier token. L'écart de 32 ms n'est pas perceptible dans ce run. La durée totale vaut
2 910 ms contre 3 157 ms. Le débit reste plus faible avec Pi, 9,24 contre 13,39 chats par seconde.
Cette paire ne comporte qu'une répétition et confirme la compatibilité du correctif, pas une
capacité statistique.

Le rejeu contrôlé sur PostgreSQL isolé, avec trois répétitions à chaque niveau, confirme un écart
local sous forte contention, mais beaucoup plus petit que les secondes observées avec PGlite avant
les corrections. Le p95 du premier token Pi ajoute 301 ms à 60 chats, 120 ms à 64 et 478 ms à 100.
Pour une personne,
cela représente environ 0,12 à 0,48 seconde pendant une rafale simultanée volontairement sévère.
Le coût propre du cycle Pi avant le prompt reste inférieur à 10 ms au p95. Le reste apparaît quand
le travail synchrone des premiers tours Pi retarde la persistance et l'ordonnancement communs des
tours suivants. Ces chiffres locaux ne mesurent ni le délai habituel d'un tour ni la capacité cloud.

Décision : poursuivre le chantier Pi et conserver AI SDK comme chemin disponible tant que la
validation cloud et le comparatif fournisseur statistique ne sont pas terminés. Aucun canary,
aucune migration générale de trafic et aucune suppression d'AI SDK ne sont couverts par cette
décision.

## Support des clés API dans Pi Chat

Le chat ne transmet jamais la clé fournisseur à Pi. Pour un modèle par clé API, la liaison conserve
l'identifiant du preset Appstrate et choisit le sérialiseur natif Pi correspondant à sa famille :
OpenAI compatible, Anthropic Messages ou Mistral Conversations. L'URL du modèle pointe vers
`llm-proxy`, avec une valeur d'authentification inerte requise par Pi.

Juste avant chaque requête fournisseur, une extension Pi injecte un nouveau jeton interne Appstrate.
Le proxy authentifie ce jeton, résout le vrai modèle et la vraie clé côté serveur, transmet la
requête, puis conserve l'attribution d'usage et sa persistance. La clé fournisseur ne se retrouve
donc ni dans le modèle Pi, ni dans la session, ni dans le navigateur. Les annulations du chat sont
aussi propagées jusqu'à la requête fournisseur.

Codex et Claude Code suivent une autre branche du même contrat : leur jeton d'abonnement est gardé
en mémoire pour le tour et Pi utilise directement son transport OAuth natif. Ce chemin n'est pas
présenté comme un comparatif avec AI SDK.

## Comment lire les métriques

Le p95 est la valeur sous laquelle terminent 95 % des conversations d'une vague. Le p95 au premier
token mesure le temps entre l'envoi du message et le début de la réponse. Il est mesuré à chaque
tour testé, pas uniquement au premier chat du processus. La durée totale s'arrête au dernier
fragment de réponse. Le débit est le nombre de conversations terminées par seconde pendant toute
la vague.

Les profils froids démarrent sans préchauffage. Les profils chauds préchauffent le processus avant
la vague. Une vague de 60 ou 100 signifie que toutes les conversations démarrent dans une fenêtre
inférieure à 250 ms. Ce scénario volontairement sévère sert à révéler la contention.

## Protocole canonique

### Bancs et ordre des fournisseurs

1. Le banc contrôlé utilise le même faux fournisseur OpenAI compatible et les mêmes fragments SSE
   pour AI SDK et Pi. Il isole le coût des moteurs.
2. Le comparatif réel utilise Mistral par clé API, le même modèle, le même proxy, la même base
   synthétique et la même charge pour les deux moteurs.
3. OpenRouter Free n'est utilisé que si une seconde clé devient nécessaire pour confirmer un
   résultat. Un modèle `:free` explicite doit alors être figé.
4. Codex et Claude Code utilisent leurs abonnements par Pi. Ils ne sont jamais présentés comme un
   comparatif direct avec AI SDK. Aucune clé API Anthropic n'est attendue.

### Invariants A/B

Chaque paire utilise le même commit, la même machine, le même modèle, les mêmes tokens, prompts,
historiques, outils, résultats d'outils et réglages. Une base PGlite ou PostgreSQL isolée, des
organisations, des utilisateurs et des sessions synthétiques sont créés pour chaque cellule. Aucun
contenu ou compte de production n'est utilisé.

Une observation est valide uniquement si elle vérifie :

- le nombre demandé de réponses terminées, hors refus de politique explicitement attendus ;
- zéro erreur serveur, stream incomplet et marqueur étranger ;
- le nombre attendu d'appels modèle et d'outils ;
- les tokens et les lignes d'usage persistés ;
- les messages et parties structurées persistés ;
- la continuité de session ;
- l'isolation entre organisations et utilisateurs.

### Charges et mesures

Les formes utiles sont S, un tour simple, H, un historique structuré de dix messages, et T, le même
historique suivi d'un appel MCP puis d'un second appel modèle. Les niveaux de référence sont 1, 10,
30, 60, 64 et 100 conversations. La comparaison statistique utilise plusieurs répétitions
appariées. Une passe unique est explicitement marquée exploratoire.

Le harness mesure au minimum : RSS initial, pic et fin, récupération après 30, 60 et 120 secondes,
heap, mémoire externe, buffers, CPU, délai de boucle événementielle, temps au premier token, durée
totale, débit, statuts HTTP, streams incomplets, appels modèle, appels d'outils, tokens, usage,
persistance, continuité et isolation.

Les seuils historiques de non-infériorité restent utiles comme alerte technique :

- premier token Pi inférieur au maximum entre AI SDK multiplié par 1,10 et AI SDK plus 250 ms ;
- durée totale Pi inférieure à AI SDK multiplié par 1,10 ;
- débit Pi supérieur à 90 % du débit AI SDK ;
- 100 % des conversations admises terminées et zéro défaut fonctionnel ;
- RSS après 120 secondes inférieur au RSS chaud augmenté de 10 %.

Ces seuils ne remplacent pas une décision produit. Un écart de débit sous une rafale synthétique
peut être acceptable si la latence vécue reste bonne et si le dimensionnement cloud offre la marge
requise.

## Résultats exploratoires après optimisation

### Rejeu contrôlé sur PostgreSQL isolé

Le rejeu au commit `56706ae7` utilise une base PostgreSQL synthétique distincte pour chaque
cellule. Chaque base reçoit les migrations réelles, puis est supprimée par le contrôleur après les
vérifications. Les valeurs sont les médianes des p95 de trois répétitions chaudes.

| Concurrence | Moteur | p95 premier token | p95 total |         Débit |
| ----------: | ------ | ----------------: | --------: | ------------: |
|          60 | AI SDK |            355 ms |    593 ms | 89,74 chats/s |
|          60 | Pi     |            656 ms |    880 ms | 64,37 chats/s |
|          64 | AI SDK |            754 ms |  1 148 ms | 52,39 chats/s |
|          64 | Pi     |            874 ms |  1 313 ms | 45,91 chats/s |
|         100 | AI SDK |          1 052 ms |  1 548 ms | 61,08 chats/s |
|         100 | Pi     |          1 530 ms |  1 882 ms | 46,51 chats/s |

Les 1 590 conversations des 36 cellules terminent. Il n'y a aucun 429, aucune erreur serveur,
aucun stream incomplet et aucun marqueur incorrect. Les 1 590 appels modèle, les tokens, les
messages, les parties structurées et les usages persistés correspondent aux attentes. La
continuité et l'isolation passent, et aucune base `chat_perf_*` ne subsiste.

À 100 chats, l'entrée dans le moteur arrive au p95 à 595 ms pour AI SDK et 1 086 ms pour Pi. Le
cycle Pi mesuré entre cette entrée et le prompt ne prend que 8,4 ms au p95. Les tours Pi déjà
entrés dans le moteur ajoutent du travail synchrone sur la boucle événementielle pendant que les
autres tours attendent leurs écritures PostgreSQL. Cela explique pourquoi le retard est visible
avant l'entrée des derniers tours sans provenir d'une requête PostgreSQL propre à Pi. Le p95 de la
boucle vaut 96 ms pour Pi contre 25 ms pour AI SDK à 100, et le CPU de vague vaut 3,10 s contre
2,54 s.

Une cellule longue à 100 mesure aussi la récupération. Le RSS Pi passe de 239,6 Mio au départ à
324,9 Mio au pic, puis 95,8 Mio après 30 secondes, 85,7 Mio après 60 et 85,8 Mio après 120. AI SDK
passe de 147,2 à 279,3 Mio, puis 65,0, 158,4 et 52,9 Mio. Les deux moteurs respectent le seuil de
récupération. Le chargement fixe observé dans ce processus vaut environ 92 Mio de RSS de plus pour
Pi, tandis que l'augmentation entre le départ et le pic est plus faible pour Pi dans cette cellule.

### Banc contrôlé ciblé

Chaque cellule ci-dessous est une répétition chaude, une organisation synthétique par chat, au
commit `fd1c56d4`. Cette passe unique est exploratoire. Elle valide le fonctionnement et donne un
ordre de grandeur, mais elle ne démontre pas une non-infériorité statistique.

| Concurrence | Moteur | p95 premier token | p95 total |         Débit |
| ----------: | ------ | ----------------: | --------: | ------------: |
|          30 | AI SDK |            174 ms |    373 ms | 73,81 chats/s |
|          30 | Pi     |            267 ms |    462 ms | 61,35 chats/s |
|          60 | AI SDK |            312 ms |    673 ms | 82,38 chats/s |
|          60 | Pi     |            576 ms |    866 ms | 66,17 chats/s |
|         100 | AI SDK |            437 ms |    968 ms | 97,26 chats/s |
|         100 | Pi     |            937 ms |  1 307 ms | 73,39 chats/s |

Les 380 conversations terminent. Il n'y a aucun 429, aucune erreur serveur, aucun stream incomplet
et aucun marqueur incorrect. Les appels modèle, tokens, messages, parties structurées et lignes
d'usage correspondent aux attentes. La continuité et l'isolation passent.

Le point 64 n'a pas été rejoué après cette dernière correction. Les résultats antérieurs à 64
existent dans les preuves historiques, mais ils ne représentent plus le chemin optimisé.

### Comparatif Mistral ciblé

Le run chaud à 60 utilise `mistral-small-2603` et traverse le vrai endpoint Appstrate,
l'authentification, la sélection de modèle, le proxy et le ledger.

| Moteur | p95 premier token | p95 total |         Débit |
| ------ | ----------------: | --------: | ------------: |
| AI SDK |          2 771 ms |  2 910 ms | 13,39 chats/s |
| Pi     |          2 803 ms |  3 157 ms |  9,24 chats/s |

Les 120 conversations terminent sans 429, erreur, stream incomplet ni défaut d'isolation. L'écart
de premier token vaut 32 ms. Le fournisseur domine donc la latence vécue sur cette paire, tandis
que la différence de débit indique encore du travail local ou de la variance fournisseur.

### Abonnements Pi

Ces mesures de charge ont été réalisées au commit `c5a35b2d`, avant le passage à Pi 0.84.2. Elles
restent un historique utile des abonnements à 1, 10 et 30, mais ne mesurent pas la version livrée.
Les validations fonctionnelles plus bas confirment séparément les chemins Pi 0.84.2 avec Codex et
Claude Code. Elles ne constituent pas un nouveau benchmark de charge.

| Abonnement             | Concurrence | p95 premier token | p95 total |        Débit |
| ---------------------- | ----------: | ----------------: | --------: | -----------: |
| Codex, GPT 5.6 Luna    |           1 |          1 962 ms |  2 184 ms |  0,46 chat/s |
| Codex, GPT 5.6 Luna    |          10 |          2 888 ms |  3 124 ms | 3,19 chats/s |
| Codex, GPT 5.6 Luna    |          30 |          3 589 ms |  3 784 ms | 7,65 chats/s |
| Claude Code, Haiku 4.5 |           1 |          2 316 ms |  2 344 ms |  0,43 chat/s |
| Claude Code, Haiku 4.5 |          10 |          2 506 ms |  2 540 ms | 3,93 chats/s |
| Claude Code, Haiku 4.5 |          30 |          3 359 ms |  3 377 ms | 8,83 chats/s |

Chaque abonnement termine 41 conversations principales sur 41, sans refus ni stream incomplet.
La persistance, l'usage, la continuité et l'isolation passent. Le niveau 60 n'est pas exécuté faute
de politique d'abonnement explicitement compatible avec cette rafale.

### Scénario fonctionnel avancé

Une instance locale neuve sur le port 3400 valide les parcours suivants :

1. le chat Pi Mistral lance un run inline, crée un document Markdown, reçoit son URI, le relit avec
   `read_document` et restitue son contenu exact ;
2. un chat Pi Codex distinct relit le même document par URI et retrouve son marqueur exact ;
3. un chat Pi Claude Code lance un run inline sur le modèle API par défaut, reçoit son résultat
   structuré et restitue son marqueur exact ;
4. un second tour dans la conversation Mistral retrouve le marqueur sans outil, ce qui valide la
   continuité et la persistance de quatre messages.

Les deux runs admis terminent `success`. Les cartes `run_and_wait` et `read_document`, leurs entrées,
sorties et détails sont persistés. Aucun tour n'atteint sa limite de pas. La preuve brute est
versionnée dans
[2026-08-19-pi-advanced-chat-functional.v1.json](./performance-results/2026-08-19-pi-advanced-chat-functional.v1.json).

Ce scénario a aussi isolé deux limites sans les confondre avec le moteur. Premièrement, Pi 0.84.2
peut normaliser l'annulation volontaire suivant l'outil terminal `output` en
`stopReason: "error"` avec le message standard `The operation was aborted.`. Le bridge reconnaît
maintenant cette forme précise comme une fin normale, uniquement après le succès d'un outil
terminal. Deuxièmement, un run explicitement lié à un abonnement OAuth exige le sidecar Docker.
L'instance `RUN_ADAPTER=process` le refuse avant inférence, tandis que le chat Claude lui-même et
son orchestration d'un run Mistral fonctionnent avec Pi.

### Validation Docker ciblée des abonnements

La même base isolée a ensuite été relancée avec `RUN_ADAPTER=docker`, le runtime
`appstrate-pi:phase4-pi-0.84.2` et un sidecar reconstruit depuis le même worktree. Deux runs inline
minimaux valident le chemin qui n'existe pas en mode processus :

| Abonnement             | État    | Runtime prêt | Appel modèle | Durée totale | Marqueur |
| ---------------------- | ------- | -----------: | -----------: | -----------: | -------- |
| Claude Code, Haiku 4.5 | success |       938 ms |       520 ms |     3 320 ms | conforme |
| Codex, GPT 5.6 Luna    | success |     1 006 ms |    72 932 ms |    75 374 ms | conforme |

Les deux runs ont persisté leur usage, un seul événement terminal et aucun `adapter_error`. Aucun
conteneur de run ne reste actif. Le temps Codex provient presque entièrement de l'appel modèle :
le runtime Docker était prêt en environ une seconde. Cette observation unique valide le chemin
fonctionnel, pas une distribution de performance fournisseur.

Le premier essai Codex avec l'ancien tag `appstrate-sidecar:latest`, construit avant le correctif
`8554de4e`, échouait en 2 117 ms avec `400 Bad Request` et zéro appel modèle. Claude passait déjà,
ce qui isolait le défaut au transport Codex. La reconstruction du sidecar courant, sans changer le
modèle ni la requête, fait passer le même scénario. Les images runtime et sidecar doivent donc être
construites et déployées comme un ensemble cohérent.

Preuve brute :
[2026-08-19-pi-docker-subscription-smoke.v1.json](./performance-results/2026-08-19-pi-docker-subscription-smoke.v1.json).

## Ce qui a été expliqué et corrigé

Cinq coûts ou défauts Appstrate propres au chemin Pi ont été isolés :

1. `ModelRuntime.create()` rafraîchissait tout le catalogue à chaque tour. Le modèle est maintenant
   résolu en amont et la création du runtime reste sous 1 ms en médiane jusqu'à 100 conversations.
2. Le placeholder d'authentification `proxy` déclenchait une synchronisation complète. Son chemin
   synchrone prend maintenant environ 0,1 à 0,2 ms à 10 conversations. Les credentials OAuth de
   Codex et Claude Code conservent leur synchronisation complète.
3. `DefaultResourceLoader.reload()` rescannait les ressources locales à chaque conversation. Le
   chat utilise maintenant un chargeur limité au prompt et aux extensions inline du tour. Le p95
   du rechargement passe de 53,2 à 2,3 ms à 30 conversations.
4. L'annulation volontaire suivant l'outil terminal `output` pouvait être classée en erreur avec
   certains adaptateurs. Le bridge reconnaît désormais le message d'annulation standard après un
   succès terminal, sans masquer les erreurs fournisseur ordinaires.
5. Pi 0.84.2 a déplacé et clarifié la normalisation OpenAI compatible des tokens de cache. Le test
   d'ancrage suit maintenant le fichier réellement distribué et l'adaptateur Appstrate conserve la
   même partition entre entrée, lecture de cache et écriture de cache sur les deux moteurs.

Le profil CPU attribuait 47,7 % de la vague Pi à la découverte synchrone avant la troisième
correction. Les accès `realpathSync`, `readFileSync`, `readdirSync`, `statSync` et `existsSync`
amplifiaient la contention. Le mapper du stream Pi vers le client prenait seulement 0,05 à 0,15 ms
et n'était pas la cause.

## Coût fixe, coût marginal et récupération

Un microprofil sur dix processus frais, au commit historique `9d921a73` avant Pi 0.84.2, mesure le
chargement du package Pi au-dessus d'AI SDK :

- import médian de 265,0 ms, avec un minimum de 185,9 ms et un maximum de 1 228,9 ms ;
- delta RSS médian de 265,9 Mio, avec une plage de 71,5 à 360,7 Mio ;
- delta heap logique médian de 673,9 Mio ;
- delta mémoire externe médian de 654,9 Mio ;
- delta buffers médian de 490,4 Mio.

Les catégories Bun se recouvrent et ne doivent pas être additionnées. Le coût fixe est un ordre de
grandeur local, pas un budget de réplica.

La cellule PostgreSQL longue à 100 conversations sépare mieux le coût fixe de l'augmentation de la
vague. Pi démarre environ 92 Mio au-dessus d'AI SDK, mais ajoute environ 85 Mio entre son état
initial et son pic contre 132 Mio pour AI SDK. Un seul point ne suffit pas à estimer une pente
marginale robuste par conversation. Heap, mémoire externe et buffers récupèrent aussi, mais leurs
catégories doivent être lues séparément du RSS.

## Limites séparées

Limite moteur : après suppression des scans de ressources, Pi conserve un coût sous forte
contention contrôlée. Le rejeu PostgreSQL à 60, 64 et 100 le confirme sur trois répétitions. Le
cycle propre de Pi reste court, mais son CPU cumulé augmente le délai de boucle et réduit la marge
de saturation pendant une rafale.

Limite fournisseur : Mistral n'a produit aucun 429 jusqu'à 100 dans la campagne historique. Cela
ne garantit aucune capacité permanente. Codex et Claude Code passent à 30, leur capacité à 60
reste inconnue.

Limite Appstrate : le plafond Pi par défaut reste 6 tant que la capacité cloud n'est pas validée.
Un test de politique avec un plafond explicitement fixé à 64 et une demande de 100 admet exactement
64 conversations et renvoie 36 réponses 429 propres, avec `Retry-After` et sans message orphelin.
Le banc moteur porte temporairement le plafond à 128 pour observer 100 conversations.

Limite cloud : la mémoire et le CPU par réplica, le nombre de réplicas, l'autoscaling, les
redémarrages, les chats actifs p95 et p99, les rafales et les distributions de tokens et d'outils
ne sont pas disponibles. Aucun chiffre local ne doit être présenté comme capacité cloud.

## Prochain travail utile

1. Rejouer Mistral à charge strictement identique si une clé dédiée reste disponible, sans élargir
   la matrice tant que le résultat ciblé suffit.
2. Instrumenter la connexion MCP, `listTools` et le taux de réutilisation du catalogue avant de
   construire un cache.
3. Tester un snapshot immuable du catalogue, avec client et autorisation toujours propres au tour.
4. Corriger ou documenter la conversion AI SDK d'un historique contenant du raisonnement avant un
   nouveau comparatif H réel.
5. Obtenir la télémétrie cloud avant toute conclusion de dimensionnement.

Le contrôle navigateur doit utiliser Chrome DevTools MCP dans Chrome Beta et le port 3400. Le port
3000 reste hors périmètre.

## Commandes de reproduction ciblées

Depuis la racine du worktree :

```bash
TEST_TIER=0 bun test scripts/chat-engine-performance.test.ts scripts/chat-engine-performance-report.test.ts
bunx tsc --noEmit -p scripts/tsconfig.json

bun scripts/chat-engine-performance.ts controlled --database=postgresql --postgres-container=appstrate-dev-postgres-1 --engines=ai-sdk,pi --forms=S --profiles=warm --concurrency=30,60,64,100 --repetitions=3 --recovery-ms=120000 --output=artifacts/chat-engine-performance/pi-current-controlled-r3
bun scripts/chat-engine-performance-report.ts --input=artifacts/chat-engine-performance/pi-current-controlled-r3 --output=docs/architecture/unified-pi-chat/performance-results/pi-current-controlled.v1.json
bun scripts/chat-engine-performance-publish.ts --input=artifacts/chat-engine-performance/pi-current-controlled-r3 --output=docs/architecture/unified-pi-chat/performance-results/raw/pi-current-controlled

bun scripts/chat-engine-performance.ts mistral --engines=ai-sdk,pi --env-file=/chemin/absolu/mistral.env --model=mistral-small-2603 --forms=S --profiles=warm --concurrency=60,64,100 --repetitions=3 --recovery-ms=120000 --output=artifacts/chat-engine-performance/pi-current-mistral-r3

bun scripts/chat-engine-performance.ts subscription --provider=codex --model=gpt-5.6-luna --env-file=/chemin/absolu/subscriptions.env --forms=S --profiles=cold --concurrency=1,10,30 --repetitions=1 --recovery-ms=120000 --output=artifacts/chat-engine-performance/subscription-codex
bun scripts/chat-engine-performance.ts subscription --provider=claude-code --model=claude-haiku-4-5 --env-file=/chemin/absolu/subscriptions.env --forms=S --profiles=cold --concurrency=1,10,30 --repetitions=1 --recovery-ms=120000 --output=artifacts/chat-engine-performance/subscription-claude
```

Le fichier Mistral ne fournit que `MISTRAL_API_KEY`. Les observations ne copient jamais la clé.

Contrôles SQL essentiels :

```sql
SELECT chat_session_id, org_id, user_id, count(*) AS model_calls,
       sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens
FROM llm_usage
WHERE chat_session_id LIKE 'chs_%'
GROUP BY chat_session_id, org_id, user_id;

SELECT count(*) AS cross_tenant_usage_rows
FROM llm_usage u
JOIN chat_sessions s ON s.id = u.chat_session_id
WHERE u.org_id IS DISTINCT FROM s.org_id
   OR u.user_id IS DISTINCT FROM s.user_id;
```

Le second résultat attendu est zéro.

## Preuves versionnées

- Format : [schéma des observations](./performance-observation.schema.json)
- Résultats de performance utiles à la PR : [synthèse compacte](./performance-results/2026-08-19-unified-pi-pr-summary.v1.json)
- Parcours chat avancé : [preuve fonctionnelle](./performance-results/2026-08-19-pi-advanced-chat-functional.v1.json)
- Runs Docker par abonnement : [preuve fonctionnelle](./performance-results/2026-08-19-pi-docker-subscription-smoke.v1.json)

Les observations détaillées restent dans les artefacts locaux du banc et peuvent être régénérées
avec les commandes ci-dessus. Les bases PGlite volumineuses restent hors Git.

## Journal de décision RFC

**19 août 2026, rejeu PostgreSQL : coût Pi confirmé sans anomalie de persistance.** Trente-six
cellules contrôlées à 1, 10, 30, 60, 64 et 100 chats, avec trois répétitions par moteur et niveau,
terminent 1 590 conversations sur 1 590. À 60, 64 et 100, Pi ajoute respectivement 301, 120 et
478 ms au p95 du premier token. Son cycle interne avant prompt reste sous 10 ms au p95. Le surplus
se forme surtout par contention de boucle quand les premiers tours Pi s'exécutent pendant la
persistance des suivants. La récupération mémoire passe à 120 secondes, la continuité et
l'isolation passent, et chaque base synthétique est supprimée. Ce rejeu confirme la viabilité
locale de Pi, pas la capacité cloud. AI SDK reste disponible et aucune migration de trafic n'est
autorisée par cette entrée.

**19 août 2026, politique de ressources du chat : poursuite de l'unification, capacité cloud en
attente.** Le profil CPU a attribué 47,7 % de la vague Pi à une découverte synchrone de ressources
locales absentes de la politique du chat. Sa suppression fait passer le p95 Pi de 1 243 à 267 ms à
30 chats. À 60 et 100 chats contrôlés, l'écart absolu du premier token vaut 264 et 500 ms. Une paire
Mistral à 60 ne mesure que 32 ms d'écart au premier token et passe tous les invariants, mais son
débit Pi reste inférieur et une répétition ne suffit pas à dimensionner le système. L'unification
Pi peut continuer pour les essais internes. AI SDK reste disponible. La capacité cloud exige encore
un rejeu statistique après correction et la télémétrie des réplicas. Aucun canary, aucune migration
générale et aucune suppression d'AI SDK ne sont autorisés par cette entrée.

**19 août 2026, validation fonctionnelle avancée : correction de la fin terminale.** Un chat Pi
Mistral a lancé un run inline, créé et publié un document, puis relu son contenu. Une première
exécution produisait le bon résultat et le bon document, mais classait l'annulation volontaire
suivant `output` comme une erreur. La classification reconnaît maintenant cette forme précise et
le rejeu réel termine `success`. Un chat Pi Codex relit ensuite le document dans une autre session,
un chat Pi Claude orchestre un run Mistral et la continuité Mistral passe au tour suivant. Cette
correction ne change ni le modèle d'outils, ni le runtime Pi, ni les permissions multitenant.

**19 août 2026, validation Docker des abonnements : chemin fonctionnel confirmé.** Un run inline
Claude Code et un run inline Codex terminent `success` avec leurs marqueurs, usages et événements
terminaux persistés. Le premier essai Codex a révélé une image sidecar plus ancienne que le
correctif de transport Codex. Un sidecar reconstruit depuis le même worktree que le runtime fait
passer le scénario sans changement de modèle ni de requête. La contrainte opératoire est de publier
runtime et sidecar comme un ensemble cohérent. Cette validation ciblée ne rejoue pas la matrice de
charge et ne permet aucune conclusion sur la capacité cloud.

La RFC source se trouve hors du worktree autorisé. Cette entrée est prête à y être reportée sans
modifier le satellite externe.
