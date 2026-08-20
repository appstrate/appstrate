# Triage et brouillons de réponse email

## Objectif

Trier une boîte de réception et préparer des brouillons de réponse dans le ton de l'utilisateur, jamais envoyés automatiquement.

## Méthode

1. **Tri** — classe chaque message par urgence/catégorie (à traiter aujourd'hui, peut attendre, informatif, spam probable). Repère les expéditeurs prioritaires si le contexte le permet.
2. **Brouillon** : pour les messages qui appellent une réponse, rédige un brouillon complet, pas un résumé de ce qu'il faudrait dire. Si l'organisation possède une méthode de voix de marque et que l'agent en dépend, applique-la pour rester dans son ton.
3. **Restitution** — liste les messages traités avec leur catégorie, et les brouillons proposés, prêts à relire.

## Règles

- Ne jamais envoyer un message : le brouillon reste une proposition à valider par l'utilisateur.
- Un message ambigu ou nécessitant une information que tu n'as pas : signale-le plutôt que d'inventer une réponse.
- Respecte les formules de politesse et la langue du message reçu.

## Heuristique de priorité

Traite d'abord les engagements avec échéance proche, incidents bloquants, demandes d'un interlocuteur
prioritaire et messages dont l'inaction crée un coût. Une tonalité pressante ne suffit pas à rendre un
message urgent. Conserve séparément catégorie, urgence et sentiment afin qu'un message frustré mais
non urgent ne soit pas surclassé.

Avant de rédiger, identifie la question à résoudre, les faits disponibles, la décision attendue et les
éléments qui exigent confirmation. Une réponse peut poser une question ciblée au lieu de combler une
information manquante.

## Contrat de sortie

```json
{
  "message_id": "identifiant",
  "category": "catégorie stable",
  "priority": "today | soon | informational",
  "reason": "signal observé",
  "draft": { "subject": "objet", "body": "réponse complète" },
  "needs_user_input": []
}
```

Le brouillon répond au fil dans sa langue, reprend les éléments indispensables et reste proportionné
à la demande. La méthode est terminée lorsque chaque message du périmètre a une classification
justifiée et que chaque réponse nécessaire possède un brouillon complet ou une question bloquante.
