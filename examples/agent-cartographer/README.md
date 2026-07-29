# Agent cartographe et ses outils

L'agent qui produit les cartes de logique, et le skill qui les vérifie avant publication.

```
agent/          @appstrate/agent-cartographer
  manifest.json   output.schema = le format logic_map, donc AJV valide la carte
                  gratuitement avant qu'elle soit persistée
  prompt.md       la consigne de typage, éprouvée à la main sur 18 cartes

skill/          @appstrate/logic-map-tools
  SKILL.md        quand et comment vérifier
  scripts/
    verify-evidence.ts   chaque citation existe-t-elle vraiment, aux lignes annoncées ?
```

## Pourquoi la vérification est dans le skill et pas dans la plateforme

Elle lit **les fichiers du bundle**, qui ne sont montés que pendant le run. Une fois la
carte publiée, plus personne ne peut vérifier qu'elle cite juste : la plateforme relit la
carte, jamais les sources.

C'est le seul contrôle qui attrape une carte inventée. Mesuré sur les 18 cartes écrites à
la main : 99,5 % de citations exactes, et les quatre échecs étaient des citations à trous,
c'est-à-dire non vérifiables par construction.

## Ce que la plateforme fait, et que le skill n'a pas à refaire

- **Valider le format** : `output.schema` est le JSON Schema de la carte, AJV le vérifie
  au retour de l'outil `output`. Une carte mal formée est refusée sans une ligne de code.
- **Croiser avec l'installation** : le croisement dépend des connexions et des réglages du
  moment, il se recalcule donc à chaque lecture (`@appstrate/core/logic-map-crosscheck`).
- **Placer les cartes** : les positions dépendent du rendu, pas du contenu de l'agent
  (`@appstrate/core/logic-map-layout`).

Figer les deux derniers dans la carte obligerait à repayer une génération de modèle à
chaque connexion établie ou changement de style.

## Essayer sans la plateforme

```bash
bun skill/scripts/verify-evidence.ts ../logic-map/wiki-brain.logic-map.json <racine-du-bundle>
```
