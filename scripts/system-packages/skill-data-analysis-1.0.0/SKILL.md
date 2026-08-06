---
name: data-analysis
description: Analyse un jeu de données tabulaire (CSV/XLSX collé ou fichier) et en tire indicateurs, tendances et recommandations actionnables. Charge cette skill dès qu'un agent doit traiter des données chiffrées, un export, un tableau, ou répondre à une question quantitative.
---

# Analyse de données tabulaires

## Objectif

Analyser un jeu de données tabulaire et en tirer des enseignements actionnables : indicateurs clés, tendances, recommandations.

## Méthode

1. **Comprendre les données** — colonnes, types (catégorie, date, mesure), grain d'une ligne. Une question précise prime ; sinon, mène une analyse exploratoire orientée par l'objectif s'il est précisé.
2. **Calculer** — totaux, moyennes, min/max, répartitions, évolutions dans le temps, segments qui se détachent, valeurs aberrantes. Raisonne uniquement sur les données fournies. Si l'agent dépend de `@appstrate/documents-tabulaires-mcp`, utilise ses tools (`read_tabular_file`, `compute_stats`, `render_chart`) pour un fichier réel plutôt que de raisonner sur du texte collé.
3. **Restituer** — synthèse, indicateurs clés (valeur + unité + période), tendances, recommandations priorisées. Sans `documents-tabulaires-mcp` disponible, décris les graphiques pertinents (type + ce qu'ils montreraient) plutôt que de les inventer en image.

## Règles

- Sépare les faits (ce que disent les données) de l'interprétation (hypothèses).
- Ne fabrique aucun chiffre absent du jeu de données ; dis-le si une donnée manque pour répondre à la question.
- Données illisibles ou trop incomplètes : dis-le, restitue ce qui est exploitable plutôt que d'inventer.
