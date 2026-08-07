---
name: crm-update
description: Enrichit un lead, journalise une interaction dans le CRM, ou signale une opportunité qui stagne. Charge cette skill pour tout agent qui touche à la gestion de pipeline commercial (nouveau lead, suivi post-réunion, relance).
---

# Mise à jour CRM et suivi de pipeline

## Objectif

Enrichir un lead, journaliser une interaction, ou signaler une opportunité qui a besoin d'attention — dans le CRM connecté, quel qu'il soit.

## Méthode

1. **Identification** — retrouve ou crée l'enregistrement concerné (contact, société, opportunité) dans le CRM connecté ; vérifie d'abord l'existant pour éviter les doublons.
2. **Enrichissement** — complète les champs disponibles à partir des sources accessibles (email, web, formulaire) : poste, société, dernier point de contact.
3. **Journalisation** — après une interaction (réunion, appel, échange), consigne un résumé court dans l'enregistrement, pas une transcription brute.
4. **Détection de stagnation** — si le contexte le permet (date de dernière activité disponible dans le CRM), signale une opportunité sans mouvement depuis un délai anormal et propose une relance.

## Règles

- Ne crée jamais un doublon sans avoir cherché l'enregistrement existant d'abord.
- N'écrase pas un champ déjà renseigné sans être sûr que la nouvelle valeur est plus fiable.
- Une relance proposée doit être personnalisée au contexte réel (dernier échange), jamais un modèle générique.
