# Digest incrémental

## Objectif

Résumer périodiquement ce qui est nouveau ou a changé depuis le dernier passage, jamais l'intégralité de la source à chaque fois.

## Méthode

1. **État précédent** — lis le `## Checkpoint` s'il existe (date/référence du dernier passage). S'il est absent, c'est le premier run : traite une fenêtre raisonnable par défaut (ex. 24-48h) et dis-le.
2. **Delta** — ne remonte que ce qui est postérieur au checkpoint : nouveaux messages, changements de statut, nouveaux documents. Filtre le bruit (mises à jour mineures, doublons déjà signalés).
3. **Restitution** — un digest court, priorisé (le plus important en premier), jamais une liste exhaustive brute.
4. **Mémoire** : avant de terminer, utilise la capacité courante de mémoire durable exposée à l'agent pour enregistrer la date ou la référence de ce passage. Le prochain run doit pouvoir repartir de ce checkpoint.

## Prérequis sémantique

Cette méthode exige une mémoire durable accessible entre les runs. L'agent doit traduire ce besoin avec la capacité que son contrat courant expose. Sans elle, produis un digest ponctuel et annonce explicitement que le prochain passage ne pourra pas calculer un delta fiable.

## Règles

- Ne jamais re-signaler un élément déjà couvert dans un digest précédent.
- Rien de nouveau depuis le dernier passage : dis-le brièvement plutôt que de forcer un contenu.
- Le digest doit rester lisible en moins d'une minute — trier, ne pas tout lister.

## Checkpoint robuste

Le checkpoint contient un curseur de source quand elle en fournit un, sinon une date UTC plus les
identifiants déjà vus à la frontière. Relis une petite zone de recouvrement autour du curseur afin de
capturer les arrivées tardives, puis déduplique par identifiant stable. Une date seule ne suffit pas
si plusieurs événements peuvent partager le même instant.

Avance le checkpoint seulement après la production réussie du digest. Un run interrompu conserve
l'ancien état afin que les éléments non livrés soient repris au prochain passage.

## Priorisation et sortie

Classe le delta par impact et action requise : blocage, décision, changement important, information.
Regroupe les notifications qui décrivent le même événement et limite le détail des éléments purement
informatifs.

```json
{
  "window": { "from": "curseur précédent", "to": "curseur observé" },
  "highlights": [{ "kind": "decision", "summary": "...", "source_id": "..." }],
  "counts": { "new": 0, "changed": 0, "ignored_duplicates": 0 },
  "next_checkpoint": { "cursor": "...", "boundary_ids": [] }
}
```

La méthode est terminée lorsque tous les événements de la fenêtre ont été classés comme retenus ou
filtrés, aucun identifiant retenu n'a déjà été livré et le nouveau checkpoint peut reprendre sans trou.
