# Unified Pi Chat, état canonique de la validation

Dernière mise à jour : 19 août 2026

Branche : `feat/chat-pi-unified-engine-phase4`

Destinataire : Pierre

Ce fichier est l'unique documentation narrative du chantier de performance Unified Pi Chat. Il
remplace l'ancien protocole séparé et la note séparée sur les extensions. Les observations JSON,
leur schéma et leurs sommes SHA-256 restent versionnés comme preuves techniques.

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

Le banc contrôlé reste plus défavorable à Pi sous forte contention locale. À 60 chats, l'écart du
premier token est de 264 ms et le débit Pi représente 80,3 % de celui d'AI SDK. À 100 chats,
l'écart est de 500 ms et le débit représente 75,5 %. Ces chiffres mesurent une rafale simultanée
sur un Mac M2 avec PGlite, pas le délai habituel de chaque tour ni la capacité cloud.

Décision : poursuivre le chantier Pi et conserver AI SDK comme chemin disponible tant que la
validation cloud et le rejeu statistique après correction ne sont pas terminés. Aucun canary,
aucune migration générale de trafic et aucune suppression d'AI SDK ne sont couverts par cette
décision.

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
historiques, outils, résultats d'outils et réglages. Une base PGlite isolée, des organisations, des
utilisateurs et des sessions synthétiques sont créés pour chaque cellule. Aucun contenu ou compte
de production n'est utilisé.

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

## Résultats actuels après optimisation

### Banc contrôlé ciblé

Chaque cellule ci-dessous est une répétition chaude, une organisation synthétique par chat, au
commit validé `fd1c56d4`.

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

Ces résultats valident seulement les chemins Pi réels.

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

## Ce qui a été expliqué et corrigé

Trois coûts Appstrate propres au chemin Pi ont été isolés :

1. `ModelRuntime.create()` rafraîchissait tout le catalogue à chaque tour. Le modèle est maintenant
   résolu en amont et la création du runtime reste sous 1 ms en médiane jusqu'à 100 conversations.
2. Le placeholder d'authentification `proxy` déclenchait une synchronisation complète. Son chemin
   synchrone prend maintenant environ 0,1 à 0,2 ms à 10 conversations. Les credentials OAuth de
   Codex et Claude Code conservent leur synchronisation complète.
3. `DefaultResourceLoader.reload()` rescannait les ressources locales à chaque conversation. Le
   chat utilise maintenant un chargeur limité au prompt et aux extensions inline du tour. Le p95
   du rechargement passe de 53,2 à 2,3 ms à 30 conversations.

Le profil CPU attribuait 47,7 % de la vague Pi à la découverte synchrone avant la troisième
correction. Les accès `realpathSync`, `readFileSync`, `readdirSync`, `statSync` et `existsSync`
amplifiaient la contention. Le mapper du stream Pi vers le client prenait seulement 0,05 à 0,15 ms
et n'était pas la cause.

## Coût fixe, coût marginal et récupération

Un microprofil sur dix processus frais mesure le chargement du package Pi au-dessus d'AI SDK :

- import médian de 265,0 ms, avec un minimum de 185,9 ms et un maximum de 1 228,9 ms ;
- delta RSS médian de 265,9 Mio, avec une plage de 71,5 à 360,7 Mio ;
- delta heap logique médian de 673,9 Mio ;
- delta mémoire externe médian de 654,9 Mio ;
- delta buffers médian de 490,4 Mio.

Les catégories Bun se recouvrent et ne doivent pas être additionnées. Le coût fixe est un ordre de
grandeur local, pas un budget de réplica.

La pente RSS marginale par conversation n'est pas estimable proprement avec la variance PGlite.
Les intervalles historiques traversent zéro. Les douze cellules longues possèdent les checkpoints
initial, pic, fin, 30, 60 et 120 secondes. Leur RSS après 120 secondes respecte le seuil de
récupération. Heap, mémoire externe et buffers doivent toutefois être lus séparément du RSS.

## Limites séparées

Limite moteur : après suppression des scans de ressources, Pi conserve un coût sous forte
contention contrôlée. Il faut le confirmer à 60, 64 et 100 avec plusieurs répétitions.

Limite fournisseur : Mistral n'a produit aucun 429 jusqu'à 100 dans la campagne historique. Cela
ne garantit aucune capacité permanente. Codex et Claude Code passent à 30, leur capacité à 60
reste inconnue.

Limite Appstrate : le plafond Pi par défaut est 64. Le test de politique à 100 admet exactement 64
conversations et renvoie 36 réponses 429 propres, avec `Retry-After` et sans message orphelin. Le
banc moteur porte temporairement le plafond à 128 pour observer 100 conversations.

Limite cloud : la mémoire et le CPU par réplica, le nombre de réplicas, l'autoscaling, les
redémarrages, les chats actifs p95 et p99, les rafales et les distributions de tokens et d'outils
ne sont pas disponibles. Aucun chiffre local ne doit être présenté comme capacité cloud.

## Extensions communautaires et optimisations retenues

Aucune extension communautaire ne doit être installée directement. `pi-mcp-adapter`, `pi-memory`,
`pi-cache-optimizer`, `context-mode`, le pi-chat officiel et `pi-continuous-learning` confirment des
principes utiles, mais ajoutent leur propre MCP, mémoire, stockage ou outils et dupliquent les
garanties multitenant d'Appstrate.

Les idées à reprendre dans le noyau commun sont :

- garder un préfixe de prompt et un bloc mémoire stables pour préserver le cache fournisseur ;
- borner et résumer les gros résultats d'outils avant leur réinjection ;
- analyser les conversations hors du chemin critique pour proposer des améliorations de skills,
  avec validation humaine avant promotion ;
- préparer un snapshot versionné du catalogue et des instructions MCP immuables.

Le cache MCP envisagé concerne uniquement le catalogue, les schémas et les instructions immuables.
Il ne concerne jamais les résultats d'outils, les autorisations ou les états de session. Les
clients, credentials, identités, historiques, signaux d'annulation et flux UI restent propres à
chaque tour. Le `DefaultResourceLoader` actuel ne doit pas être partagé directement, car ses
factories capturent des valeurs du tour.

Appstrate utilise Pi 0.84.2 sous le namespace `@earendil-works`. La mise à niveau est validée avec
Mistral, Codex et Claude Code. Elle ne justifie pas l'installation d'une extension et ne remplace
pas le profilage de notre propre intégration.

Références utiles : [Pi](https://github.com/earendil-works/pi),
[pi-chat](https://github.com/earendil-works/pi-chat),
[pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter),
[pi-memory](https://github.com/jayzeng/pi-memory),
[pi-cache-optimizer](https://github.com/jiangge/pi-cache-optimizer),
[context-mode](https://github.com/mksglu/context-mode) et
[pi-continuous-learning](https://github.com/MattDevy/pi-extensions/tree/main/packages/pi-continuous-learning).

## Prochain travail utile

1. Rejouer après correction S chaud à 60, 64 et 100, avec au moins trois répétitions appariées.
2. Rejouer Mistral à charge strictement identique si une clé dédiée reste disponible, sans élargir
   la matrice tant que le résultat ciblé suffit.
3. Instrumenter la connexion MCP, `listTools` et le taux de réutilisation du catalogue avant de
   construire un cache.
4. Tester un snapshot immuable du catalogue, avec client et autorisation toujours propres au tour.
5. Corriger ou documenter la conversion AI SDK d'un historique contenant du raisonnement avant un
   nouveau comparatif H réel.
6. Obtenir la télémétrie cloud avant toute conclusion de dimensionnement.

Le contrôle navigateur doit utiliser Chrome DevTools MCP dans Chrome Beta et le port 3400. Le port
3000 reste hors périmètre.

## Commandes de reproduction ciblées

Depuis la racine du worktree :

```bash
TEST_TIER=0 bun test scripts/chat-engine-performance.test.ts scripts/chat-engine-performance-report.test.ts
bunx tsc --noEmit -p scripts/tsconfig.json

bun scripts/chat-engine-performance.ts controlled --engines=ai-sdk,pi --forms=S --profiles=warm --concurrency=30,60,64,100 --repetitions=3 --recovery-ms=120000 --output=artifacts/chat-engine-performance/pi-current-controlled-r3
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
- Résultat courant : [politique de ressources du chat](./performance-results/2026-08-19-pi-chat-resource-policy.v1.json)
- Profils CPU : [avant](./performance-results/2026-08-19-pi-chat-resource-scan-c30-before.cpu.v1.json) et [après](./performance-results/2026-08-19-pi-chat-resource-scan-c30-after.cpu.v1.json)
- Observations courantes et sommes SHA-256 : [index](./performance-results/raw/2026-08-19-pi-chat-resource-policy/index.v1.json)
- Toutes les synthèses historiques : [performance-results](./performance-results/)

Les synthèses historiques restent des preuves de causalité et de non-régression. Leurs ratios
antérieurs à la politique de ressources ne décrivent plus la performance actuelle. Les bases
PGlite volumineuses restent hors Git.

## Journal de décision RFC

**19 août 2026, politique de ressources du chat : poursuite de l'unification, capacité cloud en
attente.** Le profil CPU a attribué 47,7 % de la vague Pi à une découverte synchrone de ressources
locales absentes de la politique du chat. Sa suppression fait passer le p95 Pi de 1 243 à 267 ms à
30 chats. À 60 et 100 chats contrôlés, l'écart absolu du premier token vaut 264 et 500 ms. Une paire
Mistral à 60 ne mesure que 32 ms d'écart au premier token et passe tous les invariants, mais son
débit Pi reste inférieur et une répétition ne suffit pas à dimensionner le système. L'unification
Pi peut continuer pour les essais internes. AI SDK reste disponible. La capacité cloud exige encore
un rejeu statistique après correction et la télémétrie des réplicas. Aucun canary, aucune migration
générale et aucune suppression d'AI SDK ne sont autorisés par cette entrée.

La RFC source se trouve hors du worktree autorisé. Cette entrée est prête à y être reportée sans
modifier le satellite externe.
