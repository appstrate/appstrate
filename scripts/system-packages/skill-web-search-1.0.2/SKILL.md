---
name: web-search
description: Chercher le web ou lire des URL depuis le chat. Charge ce guide dès que la demande exige des informations web externes. Il choisit un connecteur disponible, lance un run inline borné et restitue seulement des résultats appuyés par les sources observées.
---

# Recherche web par run inline

Le chat orchestre la recherche, un agent Appstrate utilise le connecteur web. Le résultat attendu
est une réponse fondée sur les pages réellement consultées, avec les URL nécessaires pour vérifier
chaque fait important.

## 1. Définir la preuve attendue

Choisis une seule branche avant de chercher :

- **recherche** : découvrir des pages à partir d'une question ;
- **lecture** : extraire ou résumer une liste d'URL déjà fournie ;
- **recherche puis lecture** : découvrir des candidates, puis lire seulement les plus pertinentes.

Fixe dans le prompt du run une limite d'effort et une condition d'arrêt adaptées à la demande. Pour
une question ordinaire, quelques sources indépendantes et directement pertinentes suffisent. Une
affirmation sensible ou contestée exige une source primaire quand elle existe.

Cette étape est terminée lorsque le run saura quelles affirmations étayer, combien de sources viser
et quand s'arrêter.

## 2. Choisir depuis le catalogue vivant

Découvre les intégrations disponibles et leurs connexions avec les opérations courantes du MCP.
Inspecte le détail des candidates avant de choisir : capacités, outils, destinations autorisées et
état de connexion doivent venir du contrat vivant, jamais d'une liste mémorisée dans ce guide.

Sélectionne le connecteur qui couvre toute la branche avec le moins d'intermédiaires. Une capacité de
recherche ne garantit pas la lecture du contenu complet, et une capacité de lecture d'URL ne garantit
pas la découverte. Si aucune candidate ne satisfait la preuve attendue, applique le parcours de
connexion courant. Si aucun connecteur adéquat n'existe, annonce cette limite et demande le contenu
ou une URL exploitable.

Cette étape est terminée lorsqu'un connecteur disponible possède les capacités nécessaires, ou
lorsque l'absence de chemin web est prouvée par le catalogue.

## 3. Lancer un seul run

Utilise `run_and_wait` et suis sa description vivante pour construire le run inline. Donne au run :

- un titre humain propre à cette recherche ;
- seulement le connecteur et les outils vérifiés à l'étape précédente ;
- la question, les URL éventuelles, la limite d'effort et la condition d'arrêt ;
- une consigne de progression utile, puis une restitution finale par le mécanisme de sortie courant.

Compose la recherche et la lecture dans le même run lorsque aucune décision humaine n'est nécessaire
entre les deux. Demande au run de conserver pour chaque constat son URL source et, si disponible, le
titre, l'auteur ou l'organisation et la date de publication. Une page inaccessible reste un échec
observé, pas une source.

Cette étape est terminée lorsque `run_and_wait` retourne un résultat terminal et que les sources
utilisées sont identifiables dans ce résultat ou dans son document durable.

## 4. Restituer

Réponds à partir du résultat observé. Associe les citations aux affirmations qu'elles soutiennent et
distingue clairement : fait établi, désaccord entre sources, et inférence. Si le run revient vide ou
faible, change une seule dimension utile, par exemple la requête, le type de source ou le connecteur,
puis effectue au plus une nouvelle tentative ciblée.

Considère la recherche terminée lorsque chaque affirmation importante possède une source pertinente,
ou lorsque la limite d'accès restante est nommée précisément.
