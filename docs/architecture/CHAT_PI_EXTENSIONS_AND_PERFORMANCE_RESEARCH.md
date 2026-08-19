# Pi pour le chat : extensions communautaires et pistes de performance

Date de recherche : 18 août 2026  
Périmètre : sources primaires, dépôts originaux, documentation officielle et registres npm ou
GitHub  
Version au début de la recherche : `@mariozechner/pi-coding-agent` 0.73.1.

Version migrée et validée sur la branche : `@earendil-works/pi-coding-agent` 0.84.2.

## Conclusion

Aucune extension communautaire ne doit être installée directement dans le chat Appstrate à ce
stade. Les extensions les plus populaires ajoutent leur propre MCP, leur propre mémoire ou des
outils de terminal. Elles feraient doublon avec les garanties Appstrate et pourraient fragiliser
l'isolation entre organisations et utilisateurs.

Trois idées méritent toutefois d'être reprises dans notre implémentation :

1. Conserver un préfixe de prompt aussi stable que possible entre les tours afin de préserver le
   cache du fournisseur.
2. Réduire et borner les gros résultats d'outils avant leur réinjection dans le contexte.
3. Analyser les conversations hors du chemin critique pour améliorer progressivement les skills,
   avec validation humaine avant promotion.

La piste la plus susceptible d'améliorer la latence observée reste interne à Appstrate : mesurer,
puis éviter la redécouverte du catalogue MCP et le rechargement des ressources Pi identiques à
chaque conversation. Cette optimisation ne nécessite pas une extension communautaire.

## État de l'écosystème et compatibilité

Le dépôt Pi historique redirige désormais vers `earendil-works/pi`. Appstrate utilisait
`@mariozechner/pi-coding-agent` 0.73.1 au début de cette recherche et utilise maintenant
`@earendil-works/pi-coding-agent` 0.84.2 sur la branche. Le paquet 0.73.1 exposait déjà une séparation
explicite entre la création des services liés au runtime et celle d'une session :
`createAgentSessionServices()` puis `createAgentSessionFromServices()`. Appstrate passe encore par
`createAgentSession()` et son barrel `@appstrate/runner-pi` n'expose pas ces deux fonctions. La
piste de partage contrôlé des services reste donc une optimisation distincte de la migration.

Sources :

- [Dépôt officiel Pi](https://github.com/earendil-works/pi)
- [Package courant du coding agent](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/package.json)
- [Services de session courants](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/agent-session-services.ts)
- [Services de session dans la version 0.73.1](https://github.com/earendil-works/pi/blob/v0.73.1/packages/coding-agent/src/core/agent-session-services.ts)
- [Création de session dans la version 0.73.1](https://github.com/earendil-works/pi/blob/v0.73.1/packages/coding-agent/src/core/sdk.ts)
- [Chargement des ressources dans la version 0.73.1](https://github.com/earendil-works/pi/blob/v0.73.1/packages/coding-agent/src/core/resource-loader.ts)

La différence de version était déterminante pour les extensions tierces. Les extensions modernes
les plus intéressantes déclarent généralement Pi 0.74, 0.81, 0.82 ou 0.84 comme version minimale.
La migration lève cet obstacle technique, mais pas les incompatibilités de politique, d'isolation
et de responsabilité décrites ci-dessous.

## Popularité observable

Les chiffres suivants sont un instantané, pas un classement qualitatif. Les étoiles viennent de
l'API GitHub du dépôt d'origine. Les téléchargements correspondent aux trente et un jours du
19 juillet au 18 août 2026 dans l'API npm.

- `context-mode` : 19 966 étoiles, 79 457 téléchargements. Compression du contexte, mais second
  MCP.
- `pi-mcp-adapter` : 1 268 étoiles, 499 924 téléchargements. Découverte MCP économe, mais doublon
  direct.
- `pi-web-access` : 1 152 étoiles, 277 116 téléchargements. Outils web déjà gouvernés par
  Appstrate.
- `pi-chat` officiel : 375 étoiles, pas de package npm autonome. Architecture de chat et sessions
  isolées.
- `pi-rtk-optimizer` : 241 étoiles, 14 030 téléchargements. Sorties terminal, sans intérêt pour le
  chat bridé.
- `pi-memory` : 121 étoiles, 29 659 téléchargements. Préfixe mémoire stable, concept pertinent.
- `pi-cache-optimizer` : 70 étoiles, 10 482 téléchargements. Stabilité du prompt et cache
  fournisseur.
- `pi-continuous-learning`, dépôt parent : 125 étoiles, 534 téléchargements. Apprentissage différé
  des pratiques et skills.

Sources de mesure :

- [API GitHub de context-mode](https://api.github.com/repos/mksglu/context-mode) et
  [API npm de context-mode](https://api.npmjs.org/downloads/point/2026-07-19:2026-08-18/context-mode)
- [API GitHub de pi-mcp-adapter](https://api.github.com/repos/nicobailon/pi-mcp-adapter) et
  [API npm de pi-mcp-adapter](https://api.npmjs.org/downloads/point/2026-07-19:2026-08-18/pi-mcp-adapter)
- [API GitHub de pi-web-access](https://api.github.com/repos/nicobailon/pi-web-access) et
  [API npm de pi-web-access](https://api.npmjs.org/downloads/point/2026-07-19:2026-08-18/pi-web-access)
- [API GitHub du pi-chat officiel](https://api.github.com/repos/earendil-works/pi-chat)
- [API GitHub de pi-rtk-optimizer](https://api.github.com/repos/MasuRii/pi-rtk-optimizer) et
  [API npm de pi-rtk-optimizer](https://api.npmjs.org/downloads/point/2026-07-19:2026-08-18/pi-rtk-optimizer)
- [API GitHub de pi-memory](https://api.github.com/repos/jayzeng/pi-memory) et
  [API npm de pi-memory](https://api.npmjs.org/downloads/point/2026-07-19:2026-08-18/pi-memory)
- [API GitHub de pi-cache-optimizer](https://api.github.com/repos/jiangge/pi-cache-optimizer) et
  [API npm de pi-cache-optimizer](https://api.npmjs.org/downloads/point/2026-07-19:2026-08-18/pi-cache-optimizer)
- [API GitHub du dépôt MattDevy](https://api.github.com/repos/MattDevy/pi-extensions) et
  [API npm de pi-continuous-learning](https://api.npmjs.org/downloads/point/2026-07-19:2026-08-18/pi-continuous-learning)

## Extensions et projets utiles à examiner

### Pi Chat officiel

Le projet officiel `earendil-works/pi-chat` relie Discord et Telegram à des sessions Pi isolées. Il
associe une session et une micro VM à chaque canal, diffuse les réponses progressivement, conserve
la mémoire et les skills, et permet l'arrêt ou la compaction à distance.

Ce projet confirme que Pi peut servir de noyau unique à une expérience de chat durable. Il ne peut
pas être intégré directement à Appstrate : ses transports sont Discord et Telegram, sa persistance
est locale, ses outils incluent le terminal et son environnement autorise les sorties réseau. Son
principe d'une session strictement isolée par conversation est néanmoins cohérent avec notre
architecture.

Source : [dépôt officiel pi-chat](https://github.com/earendil-works/pi-chat)

### pi-mcp-adapter

`pi-mcp-adapter` remplace de nombreux descripteurs MCP par un outil de recherche et de délégation
compact. Il démarre aussi les serveurs à la demande. Cette approche est populaire et directement
liée au coût de contexte des catalogues MCP.

Appstrate possède déjà cette abstraction : le chat expose les méta outils de recherche, de
description et d'invocation, au lieu d'envoyer tous les outils d'intégration au modèle. Installer
l'adapter créerait un deuxième hôte MCP, une deuxième configuration d'authentification et un
deuxième mécanisme de filtrage. La version courante cible en plus Pi 0.84.1.

Source : [dépôt pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter)

### pi-memory

`pi-memory` fournit une mémoire persistante, un journal quotidien, un scratchpad et une recherche
optionnelle. Son mécanisme le plus intéressant pour la performance est le snapshot stable : le bloc
de mémoire injecté reste identique entre les tours et ne change qu'à certains points de contrôle.
Le dépôt explique qu'une injection dynamique invalide le cache KV du préfixe.

L'extension ne doit pas être installée dans Appstrate. Elle ajoute ses propres outils, écrit par
défaut dans un répertoire global et injecte jusqu'à 16 000 caractères. Elle ferait doublon avec la
persistance multitenant d'Appstrate. Son exigence déclarée est Pi 0.81.1 ou plus récent.

À reprendre : produire un bloc mémoire Appstrate stable par version et ne le rafraîchir qu'après
une écriture pertinente, une compaction ou un changement explicite de session.

Source : [dépôt pi-memory](https://github.com/jayzeng/pi-memory)

### pi-cache-optimizer

`pi-cache-optimizer` tente de stabiliser le début du prompt, de compresser la liste des skills et
d'ajouter des indices de cache compatibles avec certains fournisseurs. Il expose aussi les mesures
de cache du fournisseur.

Cette extension cible Pi 0.82 ou plus récent et modifie le prompt envoyé. Elle ne doit donc pas être
branchée sur le chat actuel. L'idée de mesurer `cacheRead`, `cacheWrite` et la stabilité octet par
octet du préfixe est pertinente pour Appstrate, surtout lorsque la mémoire ou les instructions MCP
changent entre deux tours.

Source : [dépôt pi-cache-optimizer](https://github.com/jiangge/pi-cache-optimizer)

### context-mode

`context-mode` est le projet le plus visible de cette sélection. Il place les gros résultats dans
un stockage local et ne remet dans le contexte qu'une vue réduite. Son dépôt publie des scénarios
reproductibles et annonce des réductions très élevées sur les lectures de dépôts, logs, CSV et
sorties de tests.

Ce n'est pas une optimisation du temps de création d'une session Pi ni du premier token. Son
intégration ajoute un serveur MCP, onze outils et une base SQLite. Comme le chat Appstrate ne doit
voir que le MCP Appstrate autorisé, cette extension contredirait la politique actuelle.

À reprendre : borner, résumer et matérialiser les gros résultats Appstrate avant de les renvoyer au
modèle. Cette optimisation concernera surtout les conversations longues avec outils, pas le premier
tour court du benchmark.

Source : [dépôt context-mode](https://github.com/mksglu/context-mode)

### pi-continuous-learning

`pi-continuous-learning` observe les prompts, appels d'outils, erreurs et corrections, puis analyse
ces observations dans un processus distinct. Il maintient des règles apprises avec un score de
confiance et peut proposer leur promotion dans un fichier d'instructions ou un skill.

Le principe répond directement au but d'amélioration continue des skills. L'extension elle-même
n'est pas adaptée à Appstrate : elle stocke par projet sur le disque local, ajoute ses propres
outils, choisit Anthropic par défaut pour l'analyse et peut modifier des fichiers d'instructions.
Son package courant cible Pi 0.74, donc pas la version 0.73.1 d'Appstrate.

À reprendre plus tard : un pipeline asynchrone et multitenant qui agrège les signaux dans la
persistance Appstrate, propose des changements auditables, puis attend une validation avant toute
promotion en skill.

Source :
[package pi-continuous-learning](https://github.com/MattDevy/pi-extensions/tree/main/packages/pi-continuous-learning)

### Extensions sans bénéfice pour le chat bridé

`pi-rtk-optimizer` compacte les sorties de `bash`, `read`, `grep`, Git, builds et tests.
`pi-web-access` ajoute de la recherche web et de l'extraction. Ces capacités sont soit interdites
dans le chat, soit déjà fournies et gouvernées par Appstrate. Elles ne doivent pas être chargées.

Sources :

- [dépôt pi-rtk-optimizer](https://github.com/MasuRii/pi-rtk-optimizer)
- [dépôt pi-web-access](https://github.com/nicobailon/pi-web-access)

## Ce que signifie exactement « mettre MCP en cache »

Oui, le fait que le chat ne voie que le MCP Appstrate rend cette piste particulièrement logique,
mais il ne s'agit pas de mettre les réponses des outils en cache.

Le chemin actuel ouvre un client MCP pour chaque tour, effectue la négociation, demande la liste
des outils, lit les instructions, construit une factory Pi par outil, puis recharge un
`DefaultResourceLoader`. Les factories capturent des données propres au tour : identité,
autorisation, flux UI, signal d'annulation et budget temporel.

Sources locales :

- [construction MCP du chat](../../packages/module-chat/src/pi-chat/mcp-tools.ts)
- [création de la session Pi du chat](../../packages/module-chat/src/pi-chat/engine.ts)
- [création de la session Pi du runtime](../../packages/runner-pi/src/pi-runner.ts)

Les éléments suivants peuvent être envisagés comme données immuables ou préparées :

- le module Pi déjà chargé par le processus ;
- le catalogue et les schémas des méta outils Appstrate ;
- les instructions MCP stables ;
- les portions statiques du prompt système ;
- la configuration modèle qui ne contient pas de secret utilisateur ;
- une représentation préchargée des ressources Pi partagées.

Les éléments suivants doivent rester propres à chaque conversation ou tour :

- `AgentSession` et `SessionManager` ;
- historique et branche active ;
- organisation, utilisateur et application ;
- jeton, permissions et en-têtes MCP ;
- client d'appel si son cycle de vie ou son authentification est lié au tour ;
- résultats d'outils ;
- signal d'annulation, délai, compteur d'étapes et flux UI.

Il ne faut pas partager directement le `DefaultResourceLoader` actuel entre toutes les sessions
sans test de concurrence. Son runtime d'extensions contient des factories qui capturent précisément
les valeurs propres au tour. Une implémentation sûre préparerait un snapshot réellement immuable,
puis créerait les petits adaptateurs propres à chaque conversation.

Le catalogue MCP doit également être invalidé lorsque la version du serveur ou sa politique change.
Une clé de cache devrait au minimum inclure la version de surface, le périmètre d'application et
toute dimension capable de modifier la liste visible. Les réponses des outils et les autorisations
ne doivent jamais entrer dans ce cache partagé.

## Cohérence entre chat et runtime

La cohérence ne signifie pas que les deux surfaces doivent activer exactement les mêmes outils.
Elle signifie qu'elles partagent le même noyau Pi, les mêmes règles de conversion des messages, la
même politique de compaction, les mêmes niveaux de raisonnement et les mêmes conventions de skills
et mémoire. Leur politique d'outils peut ensuite différer explicitement : le chat n'expose que les
méta outils Appstrate, tandis que le runtime exécute le travail autorisé dans son environnement.

Les optimisations communes devraient donc vivre dans `@appstrate/runner-pi` ou dans un module
partagé, avec deux profils de politique explicites. Il faut éviter une extension chargée seulement
dans le chat si elle modifie le prompt, la mémoire ou la boucle agent de façon invisible au runtime.

### Migration Pi réalisée avant l'optimisation

La migration vers Pi 0.84.2 a été réalisée avant l'optimisation du bootstrap. Cette version remplace le
transport Mistral fondé sur le SDK généré par un stream HTTP natif afin de supprimer le coût du
client généré et de son runtime de schémas. Cela touche directement le fournisseur principal du
benchmark et pourrait réduire le coût fixe observé. La migration rend aussi les extensions
communautaires modernes techniquement évaluables, sans pour autant autoriser leur installation.

Ce n'était toutefois pas un simple changement de numéro. Depuis 0.73.1, le namespace npm est passé de
`@mariozechner` à `@earendil-works` et plusieurs contrats ont évolué, notamment les événements de
stream, les en-têtes des fournisseurs et les registres de modèles. Appstrate possède des adaptateurs
qui supposaient explicitement les formes 0.73.1. La migration est conservée dans un commit atomique.
Elle adapte `ModelRuntime`, les en-têtes fournisseurs et le chemin Codex, puis fait passer les tests
de conformité avant toute optimisation locale supplémentaire. Un smoke réel à concurrence 1 valide
Mistral, Codex et Claude Code. La matrice complète doit encore être rejouée pour mesurer l'effet de la
migration à forte concurrence.

Sources :

- [version Pi 0.84.2](https://github.com/earendil-works/pi/releases/tag/v0.84.2)
- [changelog du coding agent](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md)

## Ces optimisations sont elles nécessaires pour une expérience agréable ?

Elles ne sont pas nécessaires pour confirmer la viabilité architecturale ni pour un usage interne
à faible trafic. Le comparatif réel montre un moteur stable, des réponses streamées et aucune perte
fonctionnelle. À 100 chats chauds, l'écart au premier token n'est que de 369 ms. Cet écart est peu
susceptible de dominer la perception utilisateur lorsque le fournisseur met déjà plusieurs secondes
à répondre.

Elles deviennent souhaitables avant un usage soutenu, surtout pour réduire la variabilité. À 60
chats chauds, le p95 Mistral mesuré pour Pi est de 4 340 ms contre 2 375 ms pour AI SDK. Le point à
64 chats est meilleur, et celui à 100 est proche. Cette forme non monotone suggère une contention
locale ou une variance qu'il faut instrumenter, pas une pénalité constante attribuable au modèle.

Source :
[rapport de performance local](./CHAT_PI_PERFORMANCE_REPORT.md#comparatif-mistral-r%C3%A9el)

La priorité dépend donc du stade produit :

- pour une phase sans utilisateurs ou avec quelques utilisateurs internes, les performances sont
  suffisantes pour continuer avec Pi ;
- avant une ouverture plus large, réduire le travail répété du bootstrap est un investissement
  raisonnable, car il améliore la marge CPU et la stabilité sans changer l'expérience fonctionnelle ;
- les optimisations de contexte deviennent importantes lorsque les conversations et les résultats
  d'outils grossissent, même si elles n'améliorent pas nécessairement le premier tour.

## Plan d'expérimentation recommandé

1. Réalisé : migrer les packages Pi vers 0.84.2 dans un commit atomique, adapter les barrels et faire
   passer les tests de conformité, d'abonnements, de stream, de persistance et d'isolation.
2. Réalisé à concurrence 1 : rejouer un sous-ensemble Mistral, Codex et Claude Code avant toute
   autre optimisation. La matrice de charge complète reste à rejouer.
3. Ajouter des durées séparées pour la connexion MCP, `listTools`, le chargement du SDK, le
   rechargement des ressources, la création de session, le départ de la requête fournisseur et le
   premier token.
4. Vérifier ensuite une optimisation sans changement sémantique : cache versionné du catalogue et
   des instructions MCP, avec client et autorisation toujours propres au tour.
5. Désactiver explicitement dans le chargeur du chat les ressources disque qui ne font pas partie
   de sa politique, après un test prouvant que les skills Appstrate restent accessibles par le MCP.
6. Construire un chargeur léger par session à partir d'un snapshot immuable, plutôt que partager un
   runtime d'extensions mutable.
7. Stabiliser les blocs de mémoire, skills et instructions afin de préserver le cache fournisseur.
8. Rejouer exactement les mêmes cellules à 1, 10, 30, 60, 64 et 100, avec plusieurs répétitions et
   les mêmes données synthétiques.
9. Prototyper ensuite un apprentissage différé des skills inspiré de `pi-continuous-learning`, sans
   écriture automatique et sans ajout de latence au chat.

## Décision proposée

Adopter Pi comme noyau cible reste cohérent avec le bénéfice d'un seul moteur pour les modèles,
skills, mémoire et outils. Les extensions communautaires servent ici de références de conception,
pas de dépendances à installer.

Le prochain travail utile est le profilage fin du bootstrap commun, puis une optimisation mesurée du
catalogue MCP et des ressources immuables. La matrice de référence à 1, 10, 30, 60, 64 et 100 devra
ensuite être rejouée sur Pi 0.84.2. L'optimisation reste souhaitable, mais elle ne constitue pas un
prérequis pour poursuivre le chantier ou tester le chat avec un petit groupe interne.
