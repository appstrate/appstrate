# Analyse de données tabulaires

## Objectif

Analyser un jeu de données tabulaire et en tirer des enseignements actionnables : indicateurs clés, tendances, recommandations.

## Méthode

1. **Comprendre les données** — colonnes, types (catégorie, date, mesure), grain d'une ligne. Une question précise prime ; sinon, mène une analyse exploratoire orientée par l'objectif s'il est précisé.
2. **Calculer** : totaux, moyennes, min/max, répartitions, évolutions dans le temps, segments qui se détachent et valeurs aberrantes. Raisonne uniquement sur les données fournies. Pour un fichier réel, utilise la capacité courante de lecture et de calcul tabulaire exposée à l'agent plutôt qu'une transcription manuelle.
3. **Restituer** : synthèse, indicateurs clés avec valeur, unité et période, tendances, puis recommandations priorisées. Si l'agent ne possède pas de capacité de rendu, décris les graphiques pertinents et ce qu'ils montreraient.

## Règles

- Sépare les faits (ce que disent les données) de l'interprétation (hypothèses).
- Ne fabrique aucun chiffre absent du jeu de données ; dis-le si une donnée manque pour répondre à la question.
- Données illisibles ou trop incomplètes : dis-le, restitue ce qui est exploitable plutôt que d'inventer.

## Profilage avant calcul

Établis le grain d'une ligne, la période couverte, l'unité de chaque mesure, le fuseau des dates et la
clé qui définit un doublon. Compte les lignes, valeurs manquantes, doublons et valeurs hors domaine.
Une agrégation n'est interprétable que si son dénominateur et ses exclusions sont explicites.

Compare les segments sur une mesure cohérente. Un total répond au volume, un taux répond à la
proportion, une médiane résiste mieux aux extrêmes qu'une moyenne. Pour une évolution, compare des
périodes de même durée et signale une période partielle.

## Contrat de sortie

```text
Périmètre : source, grain, période, lignes retenues/exclues
Qualité : manquants, doublons, anomalies et impact
Indicateurs : valeur, unité, période, dénominateur
Constats : observation chiffrée puis interprétation séparée
Recommandations : action, signal qui la justifie, limite
```

Pour chaque constat, garde le calcul reproductible sous une forme compacte, par exemple `312 / 1 248
= 25,0 %`. Ne qualifie une valeur d'anormale qu'avec une règle nommée, une comparaison historique ou
un seuil fourni par le métier.

L'analyse est terminée lorsque les chiffres clés peuvent être recalculés depuis les données retenues,
les limites sont visibles et aucune recommandation n'est présentée comme un fait.
