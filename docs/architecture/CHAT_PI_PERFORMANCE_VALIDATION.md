# Validation de performance Unified Pi Chat

> Statut : plan à exécuter avant le canary et avant la suppression du moteur AI SDK serveur.
> Branche de référence : `feat/chat-pi-unified-engine-phase4`.

## 1. Décision attendue

Ce protocole doit répondre avec des chiffres reproductibles à deux questions distinctes :

1. À charge et entrées identiques, Pi dégrade-t-il la latence, le débit ou la consommation mémoire
   par rapport au moteur AI SDK ?
2. Unified Pi Chat peut-il servir la charge d'Appstrate Cloud avec une marge suffisante, notamment
   un pic où 100 organisations démarrent chacune un chat ?

Le résultat attendu n'est pas de prouver que Pi utilise exactement autant de mémoire. Pi peut avoir
un coût fixe supérieur et rester le bon moteur si sa latence est non inférieure et si sa mémoire
reste largement sous le budget du cloud à la concurrence cible.

## 2. Preuves disponibles et inconnues

Mesures déjà obtenues :

| Profil                                | RSS initial |   RSS pic | Résultat                           |
| ------------------------------------- | ----------: | --------: | ---------------------------------- |
| AI SDK, 7 chats simples               |    80,9 Mio | 221,2 Mio | 7 sur 7                            |
| Pi, 6 chats simples, démarrage froid  |    80,6 Mio | 337,2 Mio | 6 sur 6, le 7e refusé par la garde |
| Pi, 60 chats simples                  |    89,5 Mio | 466,5 Mio | 60 sur 60                          |
| Pi, 60 chats avec historique et outil |    68,3 Mio | 501,8 Mio | 60 sur 60, 120 appels modèle       |

Ces mesures prouvent que Pi accepte 60 chats sur la machine locale. Elles ne comparent pas les deux
moteurs à 60, car les prompts, les outils, le cache fournisseur et les tailles de charge différaient.

Inconnues à fermer avant la décision :

- pic RSS et mémoire marginale d'AI SDK à 30, 60, 64 et 100 chats ;
- comparaison froide et chaude avec les mêmes octets d'entrée et de sortie ;
- CPU, délai de boucle événementielle et nombre de connexions aux mêmes niveaux ;
- mémoire et nombre de réplicas réellement alloués à Appstrate Cloud ;
- p50, p95 et p99 des chats simultanément actifs sur le cloud actuel ;
- comportement d'un pic réparti sur 100 organisations ;
- fonctionnement de l'arrêt explicite quand plusieurs réplicas API sont utilisés.

Le Compose de référence réserve 8 Gio au conteneur Appstrate. Cette valeur ne doit pas être utilisée
comme substitut à la configuration réelle du cloud.

Préparation connue : le code de cette branche utilise maintenant 64 par défaut, tandis que
`docs/ENV.md` indique encore 6 et que le Compose de référence ne transmet pas explicitement
`CHAT_PI_MAX_CONCURRENCY` au conteneur. Aligner la documentation et le manifeste de déploiement
avant le banc de politique, afin que la valeur mesurée soit aussi celle réellement configurable.

## 3. Invariants de comparaison

Chaque cellule A/B respecte tous les invariants suivants :

- même commit et même version de Bun ;
- même machine ou même limite de conteneur ;
- processus frais distinct pour chaque moteur froid ;
- même base isolée remise dans le même état logique ;
- même modèle par clé API et même preset d'organisation pour chaque cellule A/B ;
- même chemin `llm-proxy` et même politique d'usage ;
- même prompt système, contexte appelant, historique et pièces jointes ;
- mêmes outils MCP et mêmes résultats d'outils ;
- mêmes réglages de température et de raisonnement ;
- même nombre et même longueur de tokens demandés ;
- aucun utilisateur ou contenu de production ;
- identifiants et marqueurs uniques par organisation, utilisateur et conversation.

Une cellule est invalide si les tokens d'entrée ou le nombre d'appels modèle diffèrent sans
explication. Elle doit être rejouée ou présentée comme comparaison du produit complet, jamais comme
mesure du seul moteur.

## 4. Deux bancs complémentaires

### 4.1 Banc contrôlé

Le banc contrôlé remplace la variabilité du fournisseur par un upstream déterministe derrière la
même interface `llm-proxy`. Il renvoie les mêmes fragments SSE, avec les mêmes délais et compteurs
de tokens pour les deux moteurs. Un MCP contrôlé renvoie aussi exactement le même résultat d'outil.
Cette substitution utilise un seam de test explicite et ne crée aucune route ni option accessible
dans un build de production.

Ce banc mesure :

- coût fixe de chargement du moteur ;
- mémoire marginale par chat actif ;
- CPU et délai de boucle événementielle ;
- coût de reconstruction d'un historique ;
- coût d'une boucle à deux appels modèle avec outil ;
- débit maximal du processus sans bruit réseau fournisseur.

Critère de fin : chaque moteur a exécuté toutes les cellules cinq fois, avec des sorties identiques
et les métriques brutes conservées.

### 4.2 Banc fournisseur réel

Le banc réel utilise d'abord Mistral par clé d'organisation et traverse le véritable `llm-proxy`.
OpenRouter Free peut servir de second fournisseur si un résultat doit être confirmé avec une autre
clé API. Dans ce cas, un modèle `:free` explicite est choisi dans le catalogue disponible au début
du banc, puis son identifiant exact est figé dans le manifeste. Le routeur automatique OpenRouter
n'est pas utilisé, car il pourrait envoyer les requêtes comparées vers des modèles différents.
L'ordre des exécutions suit des blocs AI SDK, Pi, Pi, AI SDK afin de réduire le biais temporel du
réseau et du fournisseur.

Deux sous-profils sont nécessaires :

- cache froid, avec un suffixe unique de longueur fixe par requête ;
- cache chaud, avec un préfixe stable répété, en enregistrant les tokens de cache lus et écrits.

Ce banc mesure le produit complet, notamment la sérialisation propre à chaque moteur. Il est exécuté
trois fois par cellule. Les erreurs, limites et files d'attente du fournisseur sont rapportées
séparément des erreurs du moteur. Les niveaux de forte concurrence qui saturent le fournisseur sont
mesurés par le banc contrôlé et ne servent pas à comparer la capacité brute des moteurs sur le banc
réel.

Critère de fin : les deux moteurs ont traversé le même proxy avec un ledger complet et aucun écart
inexpliqué dans le nombre d'appels.

### 4.3 Banc abonnements Pi

Les abonnements Codex et Claude Code traversent Pi uniquement. Ils ne peuvent donc pas remplacer le
banc A/B, puisque le moteur AI SDK ne sait pas utiliser les mêmes modes d'authentification. Ils
forment un banc Pi complémentaire qui vérifie le coût mémoire, la stabilité, la persistance et la
continuité de session dans les chemins d'abonnement réellement proposés par le produit.

Pour chaque abonnement, exécuter les niveaux `1`, `10` et `30`, puis atteindre `60` uniquement si le
fournisseur ne limite pas déjà le compte et si cette charge respecte sa politique d'utilisation.
Les ralentissements et refus du fournisseur sont séparés des erreurs du moteur. Ce banc ne peut pas
servir à conclure que Pi est non inférieur à AI SDK.

Critère de fin : chaque chemin d'abonnement admis termine sans fuite de mémoire, perte de
persistance ni rupture de continuité, avec les limites fournisseur explicitement identifiées.

## 5. Charges à exécuter

### 5.1 Formes de conversation

| Code | Forme      | Contenu                                                                    |
| ---- | ---------- | -------------------------------------------------------------------------- |
| S    | Simple     | un message utilisateur, aucune utilisation d'outil                         |
| H    | Historique | dix messages antérieurs, raisonnement, un ancien appel et résultat d'outil |
| T    | Outil      | historique H, puis un appel MCP et un second appel modèle                  |
| L    | Long       | historique proche du p95 cloud en tokens et en nombre de parties           |
| M    | Mix cloud  | proportions dérivées de la télémétrie cloud, sans contenu utilisateur      |

Les proportions du profil M sont calculées après l'étape de télémétrie. Elles ne sont pas inventées
dans le harness.

### 5.2 Niveaux de concurrence

Chaque forme est exécutée à `1`, `10`, `30`, `60`, `64` et `100` chats actifs. Les niveaux 60 et
64 répondent aux mesures locales existantes. Le niveau 100 représente un chat simultané dans
chacune des 100 organisations.

Trois distributions multi-organisations complètent la matrice :

- 100 organisations avec un chat chacune ;
- 10 organisations avec dix chats chacune ;
- une organisation avec 100 chats, uniquement dans le banc moteur qui neutralise les limites de
  débit pour mesurer la capacité brute.

Le banc moteur relève temporairement le plafond Pi à 128 et neutralise, de manière identique pour
les deux moteurs, les limites de débit qui empêcheraient d'atteindre la charge demandée. Le banc de
politique conserve ensuite les limites de production, dont le plafond Pi de 64, et vérifie que les
refus attendus sont propres et ne persistent aucun message orphelin.

Critère de fin : chaque distribution atteint le nombre de chats prévu, ou produit uniquement les
refus explicitement attendus par la politique testée.

## 6. Profils froid, chaud, rafale et endurance

Pour chaque moteur :

1. Froid : démarrer un nouveau processus, mesurer le RSS avant la première requête, puis lancer la
   charge sans préchauffage.
2. Chaud : préchauffer avec un tour, attendre la stabilisation du RSS, puis lancer la même charge.
3. Rafale : envoyer toutes les requêtes dans une fenêtre inférieure à 250 ms.
4. Rampe : augmenter la concurrence de 1 à 100 sur cinq minutes.
5. Endurance : répéter vingt vagues au niveau de concurrence p99 du cloud, avec trente secondes
   entre les vagues.

Après chaque vague, mesurer le RSS pendant deux minutes. Une mémoire qui ne revient pas vers son
niveau chaud doit être distinguée d'un simple délai du ramasse-miettes par au moins trois vagues
supplémentaires.

Critère de fin : les résultats froids, chauds, de rafale, de rampe et d'endurance sont disponibles
séparément. Aucune médiane ne mélange ces profils.

## 7. Mesures obligatoires

Le harness échantillonne le processus au moins toutes les 100 ms et produit les métriques suivantes :

- RSS, heap utilisé, mémoire externe et buffers ;
- RSS initial, pic, fin de vague, puis 30, 60 et 120 secondes après la vague ;
- CPU utilisateur et système ;
- délai p50, p95 et p99 de la boucle événementielle ;
- connexions et descripteurs ouverts ;
- temps au premier token p50, p95 et p99 ;
- durée totale p50, p95 et p99 ;
- chats terminés par seconde ;
- réponses `200`, `429`, `5xx`, annulations et streams incomplets ;
- tokens d'entrée, sortie, cache lu et cache écrit ;
- nombre d'appels modèle et d'outils par conversation ;
- coût total et coût par conversation ;
- messages, parties structurées et lignes d'usage effectivement persistés.

La mémoire est présentée sous deux formes : coût fixe au premier chargement, puis pente marginale
entre 10 et 100 chats actifs. Un ratio de pics froids seul ne doit pas être utilisé pour conclure.

Critère de fin : chaque résultat agrégé pointe vers les observations brutes qui le composent.

## 8. Télémétrie préalable du cloud

Avant le test de dimensionnement, obtenir sans contenu conversationnel :

- mémoire et CPU par réplica API ;
- nombre minimal, maximal et courant de réplicas ;
- politique d'autoscaling et délai de démarrage d'un réplica ;
- nombre de chats actifs simultanés, p50, p95, p99 et maximum sur au moins quatorze jours ;
- taux de nouveaux tours par seconde et taille des rafales ;
- distribution des tokens d'historique et du nombre d'appels d'outils ;
- distribution des modèles et des fournisseurs ;
- RSS, CPU, délai de boucle et redémarrages du processus API actuel.

Les organisations et utilisateurs sont hachés de manière stable dans l'export. Les prompts,
réponses, résultats d'outils et credentials sont exclus.

La concurrence cible de décision est le maximum entre `100` et deux fois le p99 observé. Le facteur
deux représente la marge de croissance et de rafale, pas une prévision commerciale.

Critère de fin : la fiche d'environnement cloud et la concurrence cible sont signées avant de
conclure sur la capacité.

## 9. Isolation multi-organisation

Chaque requête inclut un marqueur synthétique propre à son organisation et son utilisateur. Le
harness vérifie, par la réponse et par l'API de session authentifiée, que :

- chaque réponse contient uniquement son marqueur attendu ;
- une identité ne peut charger aucune session d'une autre identité ;
- chaque ligne d'usage porte l'organisation, l'utilisateur et la session attendus ;
- chaque outil MCP s'exécute avec les permissions du demandeur ;
- aucun message, résultat d'outil ou document ne traverse une frontière d'organisation.

Ce contrôle détecte une contamination fonctionnelle. Il ne remplace pas un audit d'isolation face
à une compromission arbitraire du processus API.

Critère de fin : zéro marqueur étranger et zéro accès inter-organisation sur toute la matrice.

## 10. Exécution dans un environnement représentatif

Le banc local sert à rendre les résultats reproductibles. La décision cloud utilise ensuite un
conteneur isolé avec :

- la même image que le déploiement ciblé ;
- la limite mémoire et CPU réelle d'un réplica ;
- PostgreSQL, Redis et stockage configurés comme sur le cloud ;
- le même nombre de réplicas que le profil testé ;
- un répartiteur équivalent à celui du cloud.

Si la configuration cloud exacte n'est pas disponible, exécuter provisoirement les profils 512 Mio,
1 Gio, 2 Gio et 8 Gio. Ces résultats restent exploratoires et ne ferment pas la décision cloud.

Pour plusieurs réplicas, vérifier aussi qu'un rechargement et un arrêt explicite atteignent le bon
producteur. Le store de reprise Redis ne prouve pas à lui seul que le registre d'arrêt local au
processus fonctionne derrière un répartiteur.

Critère de fin : le profil représentatif termine sans OOM, sans redémarrage et sans perte de reprise
ou d'arrêt.

## 11. Seuils de décision proposés

Les seuils sont approuvés avant le premier run afin d'éviter de les déplacer après avoir vu les
résultats.

### Invariants bloquants

- 100 % des conversations admises terminent avec un stream valide ;
- zéro contamination entre utilisateurs ou organisations ;
- zéro message ou ligne d'usage manquant ;
- zéro OOM, crash ou redémarrage du processus ;
- les seuls `429` sont ceux attendus par le profil de politique.

### Non-infériorité de latence

- p95 du premier token Pi inférieur ou égal au maximum entre `AI SDK × 1,10` et
  `AI SDK + 250 ms` ;
- p95 total Pi inférieur ou égal à `AI SDK × 1,10` ;
- débit Pi supérieur ou égal à 90 % du débit AI SDK.

### Capacité mémoire

- pic Pi inférieur à 70 % de la mémoire du réplica à la concurrence cible ;
- RSS après 120 secondes inférieur ou égal au RSS chaud augmenté de 10 % ;
- pente marginale calculable avec un intervalle de confiance et sans accélération entre 60 et 100 ;
- si Pi dépasse la mémoire AI SDK de plus de 25 %, le rapport sépare coût fixe et coût marginal et
  démontre malgré tout la marge cloud exigée.

La mémoire Pi n'a pas besoin d'être identique à celle d'AI SDK. Elle doit être dimensionnable et
laisser 30 % de marge au reste du processus API.

## 12. Décision

| Résultat | Condition                                                                             | Suite                                                              |
| -------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| GO       | invariants, latence et capacité mémoire passent                                       | autoriser un canary interne mesuré                                 |
| HOLD     | résultats ambigus, environnement non représentatif ou marge mémoire inférieure à 30 % | ajuster le profil ou le nombre de réplicas, puis rejouer           |
| NO GO    | contamination, perte de persistance, OOM, crash ou régression de latence confirmée    | conserver AI SDK comme version déployable et corriger avant canary |

Une différence statistique sans impact sur les seuils n'est pas un NO GO. Une moyenne favorable ne
compense jamais un invariant bloquant ou un p95 hors seuil.

## 13. Artifacts à produire

L'implémentation du protocole doit ajouter :

- `scripts/chat-engine-performance.ts`, générateur et orchestrateur de charge ;
- un format JSON versionné pour chaque observation brute ;
- un manifeste d'exécution avec commit, machine, image, limites, modèle et ordre A/B ;
- un rapport Markdown contenant les tableaux, courbes et intervalles de confiance ;
- une synthèse d'une page pour Pierre, avec les comparaisons 60 et 100 chats, le coût fixe Pi, la
  mémoire marginale par chat, la marge du réplica cloud et la décision expliquée sans extrapolation ;
- les requêtes SQL de vérification de la persistance et du ledger ;
- les commandes exactes de reproduction ;
- une entrée dans le journal de décision de la RFC.

Les résultats volumineux et les secrets restent hors de Git. Le rapport, le schéma des résultats et
les scripts reproductibles sont versionnés.

## 14. Ordre d'exécution

1. Relever la configuration et la télémétrie cloud.
   Critère : concurrence cible et budget par réplica connus.
2. Implémenter le harness et le fournisseur contrôlé.
   Critère : une cellule S à concurrence 1 produit des sorties identiques pour les deux moteurs.
3. Exécuter le banc contrôlé complet.
   Critère : cinq répétitions valides par cellule avec métriques brutes.
4. Exécuter le banc fournisseur réel A/B avec Mistral, puis confirmer avec un modèle OpenRouter
   `:free` explicite uniquement si nécessaire.
   Critère : trois répétitions valides et ledger réconcilié.
5. Exécuter le banc Pi par abonnements Codex et Claude Code.
   Critère : stabilité, persistance et limites fournisseur caractérisées séparément.
6. Exécuter les distributions à 100 organisations.
   Critère : capacité, isolation et politique de refus vérifiées.
7. Rejouer dans le profil de réplica cloud.
   Critère : aucune OOM et marge mémoire calculée.
8. Produire le rapport et la décision GO, HOLD ou NO GO.
   Critère : chaque affirmation renvoie à une observation brute reproductible.
9. Effectuer un contrôle fonctionnel final dans Chrome Beta avec Chrome DevTools MCP.
   Critère : un chat AI SDK de contrôle et un chat Pi relisent correctement leur résultat persisté.

Ce plan ne lance pas le canary, ne modifie pas le trafic de production et ne supprime pas le moteur
AI SDK serveur.

## 15. État de l'exécution locale au 18 août 2026

Le banc contrôlé S est terminé à 1, 10, 30, 60, 64 et 100, avec cinq répétitions pour les profils
froid et chaud. Les bancs H et T sont terminés à 60, 64 et 100 dans les mêmes conditions. T effectue
un appel MCP réel et deux appels modèle par conversation. Les récupérations à 30, 60 et 120 secondes
ont été relevées sur S à 60, 64 et 100. Le coût fixe du chargement Pi a été mesuré séparément sur dix
processus frais. Les distributions à 100 chats, 100 organisations par un chat, 10 organisations par
dix chats et une organisation par cent chats, sont également terminées. Le banc de politique à 100
avec plafond 64 a produit les 64 admissions et 36 refus 429 attendus, sans message orphelin.

Les invariants fonctionnels passent, mais Pi échoue aux seuils locaux de latence et de débit. La
décision locale est donc NO GO avant canary. La pente mémoire locale reste non concluante et aucune
capacité cloud n'est déduite de ces données.

Le comparatif Mistral réel S est terminé à 60, 64 et 100 pour les profils froid et chaud, avec trois
répétitions, ledger réconcilié et récupération à 30, 60 et 120 secondes. Mistral n'a produit aucun
429 jusqu'à 100. Pi reste sous le seuil de débit à 100 organisations chaudes. La forme H réelle a
mis en évidence un refus Mistral propre à la conversion AI SDK du raisonnement historique, tandis
que Pi termine la même conversation.

Les essais Pi complémentaires Codex et Claude Code sont terminés à 1, 10 et 30, sans refus ni perte
de persistance. Ils ne sont pas un comparatif direct avec AI SDK. Le niveau 60 n'a pas été tenté
faute de politique d'abonnement explicitement compatible. Chrome Beta atteint le port 3400, mais
son contrôle final reste bloqué par une interface d'extension ouverte. Une nouvelle tentative le 19
août a affiché l'inscription et rempli les champs synthétiques, puis le clic final a rencontré le
même blocage Chrome. Aucun autre navigateur n'a été utilisé.

Pi a ensuite été migré de 0.73.1 à 0.84.2. Les smoke tests réels à concurrence 1 passent pour
Mistral, Claude Code et Codex après adaptation du fournisseur natif Codex et du relais zstd OAuth.
Le comparatif Mistral chaud donne 617 ms au premier token pour Pi et 627 ms pour AI SDK sur cette
unique répétition. Ce smoke valide la compatibilité de la mise à niveau, pas une nouvelle décision de
performance. La matrice existante à 60, 64 et 100 reste la référence jusqu'à son rejeu complet avec
Pi 0.84.2.

Le 19 août, la matrice déterministe réduite S chaude a été rejouée avec Pi 0.84.2 à 60, 64 et 100,
trois répétitions appariées. Les 1 344 conversations terminent et les invariants de persistance,
d'usage, de continuité et d'isolation passent. Pi échoue néanmoins aux trois seuils à chaque niveau :
son débit représente respectivement 37,2 %, 36,4 % et 32,2 % du débit AI SDK. La décision locale
reste NO GO. Le comparatif Mistral complet post-migration reste à rejouer avec une clé dédiée. Le
smoke Mistral à concurrence 1 reste vert.

Le rapport, les commandes, le journal de décision prêt à reporter et les artifacts versionnés se
trouvent dans [CHAT_PI_PERFORMANCE_REPORT.md](./CHAT_PI_PERFORMANCE_REPORT.md).
