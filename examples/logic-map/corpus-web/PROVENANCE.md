# Provenance du corpus web

Fichiers récupérés **octet pour octet** via `gh api …/contents/<path>?ref=main` puis
`base64 -d`. Aucun en-tête ajouté : les numéros de ligne des `evidence` sont ceux du
fichier amont.

| Fichier local | Dépôt | Chemin amont | Commit | Lignes |
|---|---|---|---|---|
| `codex-cli-base-instructions.md` | `openai/codex` | `codex-rs/protocol/src/prompts/base_instructions/default.md` | `2cf2a6a844f1fc2ddd489c8a67fa8bc2f59a6f3d` | 275 |
| `codex-review-rubric.md` | `openai/codex` | `codex-rs/prompts/templates/review/rubric.md` | `81de4f251cfdaf32ecb85e2160ebfc11a562d44b` | 95 |
| `openhands-system-prompt.md` | `OpenHands/software-agent-sdk` | `tests/sdk/context/prompts/snapshots/anthropic__browser-on__secana-on__cli-on.txt` | `f835c38162a629f008ba204acb4a5eeb0f9edfdd` | 223 |
| `claude-code-deploy-with-verification.md` | `wshobson/agents` | `plugins/operating-kit/agents/deploy-with-verification.md` | `2f9990dd5337ddc88f10400c0e46893be603addf` | 69 |

Notes :

- Le prompt OpenHands est un **snapshot de test** : c'est le prompt système assemblé et figé
  par la suite de tests du SDK, donc une source primaire du texte réellement envoyé au
  modèle. Les lignes 201-224 ne font pas partie du prompt statique (contexte dynamique
  injecté à l'exécution, avec des valeurs de fixture) et ne sont pas cartographiées.
- `deploy-with-verification.md` est un **gabarit** : six variables `{{...}}` sont à
  substituer par l'intégrateur.
- Les microagents OpenHands cités en piste n'existent plus sous ce nom dans
  `OpenHands/OpenHands` (dépôt restructuré) ; le snapshot du SDK les remplace avantageusement,
  puisqu'il donne le prompt complet plutôt qu'un fragment.
