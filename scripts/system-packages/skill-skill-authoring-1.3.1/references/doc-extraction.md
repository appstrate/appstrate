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
