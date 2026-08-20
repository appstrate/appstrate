# Extraction de champs structurés

## Objectif

Extraire d'un document (facture, formulaire, contrat) les champs pertinents sous forme structurée, en signalant ce qui est incertain ou manquant.

## Méthode

1. **Lecture** : utilise la capacité courante d'extraction ou de lecture documentaire exposée à l'agent. Si aucune capacité ne rend le document lisible, signale le prérequis manquant au lieu d'inventer son contenu.
2. **Extraction** — champs typiques selon le type de document (facture : fournisseur, montant, devise, échéance, numéro ; formulaire/contrat : champs déclarés par l'agent).
3. **Vérification** — signale les incohérences détectables (total qui ne correspond pas à la somme des lignes, numéro dupliqué, date antérieure à la précédente facture du même fournisseur si l'historique est disponible).
4. **Restitution** — objet structuré + liste des anomalies/champs manquants, jamais une valeur inventée pour combler un trou.

## Règles

- Un champ illisible ou absent reste vide, avec la raison, plutôt qu'une valeur approximative.
- Signale toujours le niveau de confiance sur les champs ambigus (montant flou, écriture manuscrite).
- Ne valide jamais silencieusement une anomalie détectée — elle doit remonter dans la restitution.

## Schéma d'extraction

Définis les champs attendus avant la lecture. Pour chaque champ, conserve quatre éléments : valeur
normalisée, texte ou zone source, état et confiance. Les états possibles sont `present`, `absent`,
`illegible` et `conflict`. La confiance ne répare jamais un état absent.

```json
{
  "field": "total_due",
  "value": { "amount": "1250.00", "currency": "CAD" },
  "evidence": "Total à payer 1 250,00 $",
  "status": "present",
  "confidence": "high"
}
```

Normalise les dates, nombres et devises dans la valeur, puis préserve la forme lue dans `evidence`.
Pour un document multi-pages, ajoute page ou emplacement. Vérifie les invariants calculables, par
exemple sous-total plus taxes égale total dans la tolérance d'arrondi de la devise.

## Contrat de sortie

Retourne l'identité du document, les champs structurés, les anomalies et les champs nécessitant une
validation humaine. N'écrase pas deux valeurs contradictoires, conserve les deux avec leurs preuves.

L'extraction est terminée lorsque chaque champ demandé possède un état explicite, chaque valeur
ambiguë remonte sa preuve et toutes les vérifications arithmétiques applicables ont été effectuées.
