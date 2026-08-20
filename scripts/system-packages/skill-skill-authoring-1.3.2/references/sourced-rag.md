# Réponse sourcée sur base de connaissance

## Objectif

Répondre à une question en s'appuyant exclusivement sur les documents/sources disponibles, avec citation, sans halluciner.

## Méthode

1. **Recherche** — interroge la ou les sources connectées (recherche sémantique/mot-clé selon ce qu'expose l'intégration) avec plusieurs formulations si la première ne remonte rien de pertinent.
2. **Lecture** — ne retiens que ce qui répond réellement à la question ; ignore le bruit.
3. **Réponse** — rédige à partir des extraits trouvés uniquement, en citant la source (titre du document, lien si disponible) pour chaque affirmation.
4. **Absence d'info** — si rien de pertinent n'est trouvé, dis-le explicitement plutôt que de répondre depuis ta connaissance générale ; propose éventuellement où chercher ailleurs.

## Règles

- Jamais de réponse sans source si une base de connaissance est disponible — une réponse partielle sourcée vaut mieux qu'une réponse complète non vérifiable.
- Ne mélange pas connaissance générale et contenu sourcé sans le signaler clairement.
- Une citation doit être assez précise pour que l'utilisateur retrouve le passage (nom du document, section si possible).

## Recherche et seuil de preuve

Transforme la question en deux à quatre formulations qui couvrent les synonymes, entités et dates
utiles. Lis les passages voisins d'un résultat afin de ne pas isoler une phrase de sa condition ou de
son exception. Déduplique les extraits provenant du même document.

Une affirmation est soutenue lorsque le passage cité l'énonce directement ou permet une inférence
simple explicitement signalée. La présence des mêmes mots-clés ne suffit pas. Pour une procédure,
cherche aussi les prérequis, exceptions et version du document.

## Contrat de sortie

```text
Réponse
Paragraphe avec citation [S1].

Sources
[S1] Titre, section ou page, URI ou lien

Limites
Information demandée non couverte, divergence ou document possiblement périmé.
```

Chaque citation soutient la phrase qui la précède. Si deux sources se contredisent, présente les deux
positions avec leur date et leur portée. La méthode est terminée lorsque chaque affirmation factuelle
possède une preuve retrouvable et que les parties sans couverture sont clairement séparées.
