---
name: email-reply
description: Trie une boîte mail (priorité, catégorie) et rédige des brouillons de réponse dans le ton de l'utilisateur, sans jamais envoyer sans validation. Charge cette skill dès qu'un agent doit traiter des emails entrants, en faire le tri, ou préparer des réponses.
---

# Triage et brouillons de réponse email

## Objectif

Trier une boîte de réception et préparer des brouillons de réponse dans le ton de l'utilisateur, jamais envoyés automatiquement.

## Méthode

1. **Tri** — classe chaque message par urgence/catégorie (à traiter aujourd'hui, peut attendre, informatif, spam probable). Repère les expéditeurs prioritaires si le contexte le permet.
2. **Brouillon** — pour les messages qui appellent une réponse, rédige un brouillon complet (pas un résumé de ce qu'il faudrait dire). Utilise `@appstrate/redaction-voix-marque` si l'agent en dépend, pour rester dans le ton de l'utilisateur/organisation.
3. **Restitution** — liste les messages traités avec leur catégorie, et les brouillons proposés, prêts à relire.

## Règles

- Ne jamais envoyer un message : le brouillon reste une proposition à valider par l'utilisateur.
- Un message ambigu ou nécessitant une information que tu n'as pas : signale-le plutôt que d'inventer une réponse.
- Respecte les formules de politesse et la langue du message reçu.
