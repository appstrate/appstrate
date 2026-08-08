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
