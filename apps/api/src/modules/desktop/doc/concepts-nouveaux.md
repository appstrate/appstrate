# Pont desktop — les concepts nouveaux dans le corps

Ce document explique **uniquement ce qui s'éloigne du modèle Appstrate d'avant**.
Le reste (modules auto-découverts, intégrations AFPS, delivery HTTP, credential
proxy) est inchangé. Ici on éclaire les deux ou trois briques nouvelles, avec des
schémas, et surtout **pourquoi** elles existent.

---

## 1. Le décor : un agent hébergé qui pilote un navigateur local

Avant, un agent Appstrate vivait entièrement dans le cloud : il parlait à des API
via les intégrations. Il n'avait aucun bras dans le monde réel de l'utilisateur.

Le pont desktop ajoute ce bras. L'app Electron tourne sur le Mac de l'utilisateur
et **se connecte au cloud** (pas l'inverse). Le cloud lui envoie des ordres, elle
pilote le Chromium embarqué.

```
        CLOUD (corps Appstrate)                 MACHINE DE L'UTILISATEUR
  ┌───────────────────────────────┐        ┌──────────────────────────────┐
  │  Agent (run)                   │        │  App Electron                │
  │    │                          │        │    ┌──────────────────────┐  │
  │    │ tool: desktop_browser    │        │    │  Chromium embarqué   │  │
  │    ▼                          │        │    │  (le vrai navigateur │  │
  │  module `desktop`             │        │    │   de l'utilisateur)  │  │
  │    │  /internal/desktop-command│       │    └──────────▲───────────┘  │
  │    ▼                          │        │               │              │
  │  WS bridge  ◄─────────────────┼────────┼──── client.ts (JSON-RPC)     │
  │  /api/desktop/bridge          │  cookie│               │              │
  └───────────────────────────────┘  session└──────────────┘              │
                                          └──────────────────────────────┘
```

Point clé : c'est **l'app qui appelle le cloud**, avec le cookie de session de la
webapp embarquée. Le cloud ne connaît jamais l'adresse IP de la machine. Analogie :
ce n'est pas le siège qui téléphone à l'employé, c'est l'employé qui garde une
ligne ouverte vers le siège et attend les instructions.

Le canal est du **JSON-RPC 2.0** simple : le cloud envoie `{method, params}`,
l'app répond `{result}` ou `{error}`, et l'app peut pousser des **notifications**
(un téléchargement qui se termine) sans qu'on lui ait rien demandé.

---

## 2. LE concept vraiment nouveau : le credential à portée run (« éphémère »)

C'est le cœur de ce qui change dans le corps. Tout le reste en découle.

### 2.1 Ce qu'on avait avant : le credential durable

Le modèle historique d'un credential Appstrate :

```
  On le connecte UNE FOIS, hors ligne (OAuth, clé API saisie…).
        │
        ▼
  Il est chiffré et PERSISTÉ en base.
        │
        ▼
  À chaque run, on le déchiffre et on l'injecte dans l'appel API.
        │
        ▼
  S'il expire → refresh OAuth → on réécrit le nouveau en base.
        │
        ▼
  Si le refresh échoue → on marque `needs_reconnection`,
                          le prochain run est BLOQUÉ au démarrage
                          tant que l'humain n'a pas reconnecté.
```

Ce modèle suppose une chose : **le secret existe avant le run et lui survit.**

### 2.2 Le cas qui casse ce modèle

Certains sites (Communauto, et plus largement tout site Cloudflare / OIDC) ne
donnent pas de clé API. Le seul « credential » exploitable est un **jeton de
session** qu'on lit dans la page une fois connecté. Ce jeton :

- est **acquis PAR le run lui-même** (l'agent se connecte, puis lit le jeton) ;
- est **de courte durée** (il faut le reprendre à chaque run) ;
- ne doit **jamais** être persisté.

Si on le range dans le modèle durable, on crée un **interblocage** :

```
  jeton expiré → 401 → on marque `needs_reconnection`
       │
       ▼
  prochain run BLOQUÉ au démarrage
       │
       ▼
  mais pour ré-acquérir le jeton, IL FAUT un run qui ouvre le navigateur…
       │
       ▼
  …qui est bloqué. Deadlock. Personne ne peut débloquer sans intervention manuelle.
```

C'est exactement le « reconnexion requise » qu'on voyait, sans issue automatique.

### 2.3 La solution : un magasin en mémoire, à portée du run

On arrête de faire passer ce jeton par le modèle durable. Il vit dans un
**magasin process-local**, une simple `Map`, indexée par `runId:integrationId:authKey`,
balayée après le run.

```
  fichier: services/run-ephemeral-credentials.ts

  ┌─────────────────────────────────────────────────────────┐
  │  Map en mémoire (JAMAIS en base, JAMAIS sur disque)      │
  │                                                          │
  │   "run_02b4… @tractr/communauto primary"                 │
  │        → { access_token: "eyJ…" }   (TTL 2h, balayé)     │
  └─────────────────────────────────────────────────────────┘
```

La connexion durable, elle, ne garde que le **secret stable** : email + mot de
passe. Ce secret n'est jamais injecté dans un appel API, donc jamais soumis à un
401, donc jamais marqué « reconnexion requise ».

### 2.4 Le point de couture dans le résolveur

Un seul endroit du corps a été touché pour brancher tout ça :
`integration-credentials-resolver.ts`. Deux greffes minuscules.

**Greffe A — la fusion (ligne ~165).** Après avoir déchiffré les champs durables,
on fusionne le jeton éphémère par-dessus. L'éphémère gagne.

```
  fields = déchiffrer(connexion durable)      // { email, password }
  ephemeral = getRunEphemeralCredentials(runId, integ, auth)  // { access_token }
  if (ephemeral) fields = { ...fields, ...ephemeral }         // le frais écrase
```

**Greffe B — le refresh non terminal (ligne ~348).** Une auth marquée éphémère ne
déclenche JAMAIS le `needs_reconnection`. Si un 401 demande un forceRefresh, on ne
jette pas le jeton, on laisse la fusion (greffe A) avoir déjà mis le jeton frais.

```
  } else if (options.forceRefresh === true && !isEphemeralAuth) {
      await flagTerminalAndThrow(…)   // comportement d'avant, INCHANGÉ
  }
  // si isEphemeralAuth : on ne bloque pas, on retombe sur le jeton fraîchement capturé
```

Le marqueur qui déclenche ce comportement vient du manifeste d'intégration :
`_meta["dev.appstrate/ephemeral"]`. C'est déclaratif : l'intégration dit « mon
secret est volatil », le corps adapte son cycle de vie.

### 2.5 La boucle complète, enfin fermée

```
  1. Agent ouvre le navigateur, se connecte (mot de passe saisi côté machine)
  2. browser.capture lit le jeton dans la page  ───►  setRunEphemeralCredentials()
  3. Premier api_call : le résolveur fusionne le jeton frais (greffe A) → 200
  4. Si un payload de boot a un vieux jeton → 401 → forceRefresh
        → auth éphémère → PAS de blocage (greffe B) → retombe sur le jeton capturé → 200
  5. Fin du run → le jeton est balayé. Rien ne survit.
```

Aucun déblocage manuel possible parce qu'aucun blocage n'est possible. Générique :
ça marche pour n'importe quel site à jeton volatil, pas seulement Communauto.

---

## 3. La sécurité : l'agent ne voit jamais aucun mot de passe

C'est l'exigence de base non négociable. Le mécanisme repose sur une idée simple :
**le secret ne transite jamais par la conversation de l'agent.** L'agent manipule
des jetons de forme `{{champ}}`, le corps les remplace au dernier moment, et
nettoie tout ce qui revient.

### 3.1 Substitution sortante : `{{field}}` remplacé au bord

L'agent écrit, par exemple, « remplis le champ mot de passe avec `{{password}}` ».
Le mot de passe réel n'est jamais dans la commande de l'agent. C'est le module
`desktop`, à la frontière, qui résout `{{password}}` en vraie valeur juste avant
d'envoyer l'ordre à la machine.

```
  Agent  ─── "browser.fill  #pass  {{password}}" ───►  module desktop
                                                           │
                            résout via le résolveur de credentials
                                                           │
                        "browser.fill  #pass  hunter2"  ───┘───► app Electron
                                                                  (reste LOCAL)
```

Deux garde-fous durcissent ce chemin :

- **Allowlist des méthodes substituables** (`SUBSTITUTABLE_METHODS`). Seuls
  `browser.fill` et `browser.evaluate` acceptent une substitution. On refuse par
  exemple de substituer dans l'URL d'un `browser.navigate` : sinon un agent
  malveillant mettrait le secret dans une URL et l'exfiltrerait. La valeur
  substituée doit rester sur la machine de l'utilisateur.
- **Gate fail-closed** : l'agent qui demande une substitution doit avoir déclaré
  l'intégration concernée. S'il ne l'a pas déclarée, refus. Un agent ne peut pas
  aller « piocher » le secret d'une intégration qu'il n'utilise pas.

### 3.2 Nettoyage entrant : le scrubbing anti-relecture

Que se passe-t-il si une page renvoie le secret dans un message d'erreur, ou si
l'agent essaie de le relire ? Toute réponse d'un run qui a utilisé une
substitution est **nettoyée** des valeurs substituées avant de remonter à l'agent
(`secret-scrub.ts`).

```
  app Electron ── réponse (peut contenir "hunter2") ──► module desktop
                                                           │
                                     scrubRunSecrets(runId, …) remplace le secret
                                                           │
                          réponse expurgée ───────────────┘───► Agent (ne voit rien)
```

Substitution protège le chemin **sortant**, scrubbing protège le chemin
**entrant**. Les deux ensemble : le secret entre par le bord, agit localement,
et ne ressort jamais.

### 3.3 La capture write-only du jeton, sans usurpation

Lire le jeton de session dans la page (pour le magasin éphémère) est délicat : un
script contrôlé par l'agent pourrait mentir sur la page où il s'exécute et faire
capturer un jeton d'un autre site. Deux protections :

1. **L'URL vient d'une source de confiance, pas du script.** Le script de capture
   renvoie seulement les champs ; l'URL de la page est lue par le processus
   principal via `wc.getURL()`, que le script ne peut pas falsifier.
2. **La page source est liée aux `authorized_uris` de l'intégration.** Le corps
   vérifie que l'URL réelle de la page fait partie des hôtes autorisés de
   l'intégration avant d'écrire quoi que ce soit dans le magasin. Impossible de
   capturer un jeton depuis une page hors périmètre.

```
  browser.capture ─► script lit les champs { access_token }
                     wc.getURL() ─► "https://quebec.client.reservauto.net/…"  (fiable)
                          │
             est-ce dans authorized_uris de @tractr/communauto ?
                          │ oui
                          ▼
             setRunEphemeralCredentials(...)   ← écriture autorisée
```

### 3.4 Le canal lui-même : garde CSWSH

Le pont est un WebSocket. Sans protection, un site web tiers ouvert dans un
navigateur pourrait tenter d'ouvrir ce WebSocket et piloter la machine
(Cross-Site WebSocket Hijacking). L'upgrade WS valide donc l'`Origin`
(`isTrustedUpgradeOrigin`) : seules les origines de confiance montent le pont.

---

## 4. Deux petites primitives nouvelles (utiles, pas centrales)

### 4.1 `browser.batch` — une séquence figée en un seul aller-retour

Un skill de connexion fait toujours la même danse : aller sur la page, remplir
l'email, remplir le mot de passe, cliquer, attendre. Plutôt que 5 allers-retours
cloud↔machine (lents, et 5 occasions de rate un pas), on envoie la séquence
**entière** en un message. La machine l'exécute pas à pas, s'arrête au premier
échec, et renvoie un résultat partiel avec l'index du pas fautif.

La substitution `{{field}}` est appliquée **par pas** avant l'envoi, et le
résultat est scrubbé. Mêmes garanties de sécurité que pour une commande unique.

```
  batch: [ navigate, fill email, fill {{password}}, click, waitForSelector ]
      │  (un seul message WS)
      ▼
  machine exécute 1→2→3→4→5, stoppe au 1er échec, renvoie { completed, results, error? }
```

### 4.2 CDP pour navigate / evaluate / screenshot

`navigate`, `evaluate` et `screenshot` passent par le **Chrome DevTools Protocol**
(le debugger natif d'Electron), attaché le temps de l'appel puis détaché. Une
exception délibérée : la navigation attend l'événement Electron `did-finish-load`
plutôt que l'événement CDP, pour ne pas se faire repérer par les anti-bots au
démarrage de la page.

---

## 5. Récapitulatif de bout en bout

Le run Communauto qui a tout validé, vu d'en haut :

```
  ┌─ CLOUD ──────────────────────────────┐   ┌─ MACHINE ─────────────────────┐
  │                                       │   │                               │
  │  Agent                                │   │  App Electron + Chromium      │
  │   │ 1. batch login                   │   │                               │
  │   ▼                                   │   │                               │
  │  module desktop                       │   │                               │
  │   │  substitue {{password}} au bord ──┼──►│  se connecte (secret LOCAL)   │
  │   │                                   │   │                               │
  │   │ 2. browser.capture                │   │                               │
  │   │  ◄── { url fiable, access_token }─┼───┤  lit le jeton de la page      │
  │   │  vérifie authorized_uris          │   │                               │
  │   │  setRunEphemeralCredentials()     │   │                               │
  │   │      → Map en mémoire (run-scoped)│   │                               │
  │   │                                   │   │                               │
  │   │ 3. api_call GET facture           │   │                               │
  │   │  résolveur: fusion jeton frais ───┼──►│  (delivery HTTP, credential   │
  │   │  401 boot? forceRefresh non bloq. │   │   proxy, INCHANGÉ)            │
  │   │  toFile → workspace               │   │                               │
  │   │                                   │   │                               │
  │   │ 4. api_upload → Google Drive      │   │                               │
  │   ▼                                   │   │                               │
  │  fin run → jeton éphémère balayé      │   │                               │
  └───────────────────────────────────────┘   └───────────────────────────────┘

  Ce que l'agent a vu du secret : RIEN. Ni le mot de passe, ni le jeton en clair.
  Ce qui a été persisté du jeton : RIEN.
```

---

## 6. En une phrase

Le seul concept structurellement neuf est le **credential à portée run
(éphémère)** : un secret acquis par le run, gardé en mémoire, fusionné par-dessus
la connexion durable, jamais persisté, jamais bloquant. Tout le volet sécurité
(substitution au bord + scrubbing + capture liée aux `authorized_uris` + garde
CSWSH) existe pour tenir une seule promesse : **l'agent ne voit jamais aucun mot
de passe.**
