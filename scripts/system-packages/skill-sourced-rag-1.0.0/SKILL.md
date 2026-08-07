---
name: sourced-rag
description: Répond aux questions à partir d'une base de connaissance (documents, wiki, Drive, Notion) en citant les sources et en disant explicitement quand l'information manque. Charge cette skill dès qu'un agent doit répondre en s'appuyant sur des documents internes plutôt que sur sa connaissance générale.
---

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
