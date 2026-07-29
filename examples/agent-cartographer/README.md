# Agent cartographe et ses outils

L'agent qui produit les cartes de logique, et le skill qui les vérifie avant publication.

```
integration/    @appstrate/platform-api
  manifest.json   accès authentifié à l'API de la plateforme elle-même

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

## Comment l'agent lit ce qu'il cartographie

Un agent tourne dans un conteneur isolé, **sans jeton de plateforme** — l'entrypoint
supprime l'adresse du sidecar après la poignée de main, précisément pour qu'il ne puisse
pas la lire. Il ne peut donc pas appeler l'API comme le fait le chat, qui, lui, s'exécute
dans le processus de la plateforme et dispatche en interne.

Le chemin existe quand même : le proxy sortant du sidecar autorise explicitement l'hôte de
la plateforme. Il ne manquait qu'une identité, d'où l'intégration `@appstrate/platform-api`
et sa clé API.

Deux routes suffisent pour le manifeste et le prompt, qui arrivent déjà extraits du ZIP.
Pour les **fichiers de références d'un skill**, en revanche, il faut télécharger l'archive
et l'ouvrir : la route JSON ne rend que le `SKILL.md`. C'est une contrainte réelle, pas un
détail — c'est dans ces fichiers que vivent les règles qui font foi.

## Avant d'importer l'intégration : deux minutes de configuration

`integration/manifest.json` est un **modèle**, pas un package prêt à l'emploi.

1. **Remplacez l'hôte** dans `authorized_uris` par celui de votre instance :

   ```jsonc
   "authorized_uris": [
     "http://localhost:3300/api/packages/**",   // au lieu de VOTRE-INSTANCE.example
     "http://localhost:3300/api/agents/**"
   ]
   ```

2. **Créez une clé API en lecture seule**, dédiée à cet usage. Jamais une clé
   d'administration : elle donnerait à l'agent le droit de lancer des runs et de modifier
   des agents, alors qu'il n'a besoin que de lire des définitions.

3. Importez, connectez, et branchez la connexion sur le cartographe.

### Pourquoi ce n'est pas automatique

La liste d'URI autorisées est **littérale** : elle n'accepte aucune substitution, ni depuis
la configuration de l'agent, ni depuis les credentials. C'est délibéré — sinon un agent mal
réglé pourrait élargir lui-même ce qu'il a le droit d'appeler.

La conséquence est qu'un manifeste générique, valable pour toutes les instances, devrait
déclarer `allow_all_uris`. Le sidecar poserait alors l'en-tête d'authentification sur
l'adresse que l'agent nomme, **quelle qu'elle soit** : un prompt détourné suffirait à
expédier la clé ailleurs. L'agent n'aurait jamais vu le secret, mais le serveur d'en face
le lirait dans l'en-tête.

Personnaliser l'hôte supprime ce risque : la liste blanche redevient effective, et une
mauvaise configuration se manifeste par un 403 explicite plutôt que par une porte ouverte.

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
