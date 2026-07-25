# Harnais e2e du pont desktop multi-onglets

`desktop-tabs-e2e.ts` exécute la chaîne complète contre une instance
réelle et l'app Electron réelle: HTTP → bail → WebSocket → TabManager →
CDP → un onglet Chromium vivant. Les assertions lisent ce que la page
affiche vraiment, pas ce que la plateforme croit avoir fait.

## Prérequis

1. Une instance qui charge le module `desktop` (`MODULES=…,desktop`).
2. L'app Electron lancée et connectée (le bail est par personne: le
   script pilote les runs de l'utilisateur dont le desktop est branché).
3. `PLATFORM` dans le script pointe sur l'instance (défaut `:3100`).

## Exécution

```sh
bun run apps/api/scripts/desktop-tabs-e2e.ts
```

Le script démarre son propre site de test sur `127.0.0.1:4599` (une page
qui pose un cookie de session et le rejoue), crée deux agents jetables et
trois runs, puis nettoie derrière lui.

Compter environ 3 minutes: le dernier test attend l'expiration du bail
d'origine (2 min) pour vérifier qu'un run ultérieur du même agent
retrouve son profil sans se reconnecter.

## Ce qui est vérifié

| Test                                    | Ce qu'il prouve                                                         |
| --------------------------------------- | ----------------------------------------------------------------------- |
| onglet implicite                        | un agent qui ignore les onglets fonctionne sans changement de manifeste |
| session vue par son agent               | le profil retient bien la connexion                                     |
| **agent B ne voit pas la session de A** | l'isolation entre agents, le coeur du modèle                            |
| deux runs en parallèle                  | des profils distincts ne se sérialisent pas                             |
| 409 même agent, même site               | les profils réellement partagés sont sérialisés                         |
| 409 sur l'onglet d'un autre run         | la propriété d'onglet tient                                             |
| 410 sur onglet fermé                    | l'agent sait rouvrir plutôt que de se croire chez lui                   |
| quota                                   | 3 onglets par run                                                       |
| profil réutilisé au run suivant         | pas de re-login à chaque run                                            |

Après un passage, aucun package `@e2e/*` ni profil `appstrate-agent-e2e-*`
ne doit subsister.
