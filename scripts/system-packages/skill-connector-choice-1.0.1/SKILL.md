---
name: connector-choice
description: Choisir comment connecter un service à un agent. Charge ce guide quand plusieurs connecteurs ou modes d'accès sont possibles, ou quand aucun connecteur adéquat n'est installé. Il arbitre friction, couverture et sécurité à partir du catalogue vivant.
---

# Choisir un connecteur

Choisis le chemin d'accès qui couvre le besoin réel avec le moins de configuration et de privilèges
pour l'utilisateur. Le catalogue et les descriptions d'opérations courantes possèdent les détails
techniques. Ce guide possède l'arbitrage.

## 1. Nommer le besoin

Liste les actions requises, les données lues ou écrites, le compte concerné et la fréquence. Sépare
les prérequis indispensables des capacités seulement confortables. Un connecteur qui couvre neuf
actions sur dix ne convient pas si la dixième porte le résultat attendu.

Cette étape est terminée lorsque chaque capacité indispensable peut être testée contre une candidate.

## 2. Comparer les candidates vivantes

Découvre les intégrations disponibles, puis décris les candidates plausibles. Évalue dans cet ordre :

1. couverture des actions indispensables ;
2. état déjà connecté ou activé pour l'application ;
3. permissions et destinations réellement exposées ;
4. effort demandé à l'utilisateur pour connecter et maintenir l'accès ;
5. provenance et maintenance du connecteur.

Quand une intégration MCP distante maintenue par le fournisseur couvre le besoin, préfère-la à une
intégration qui oblige l'utilisateur à gérer sa propre application développeur. Une intégration API
reste préférable si elle possède une capacité indispensable absente de la variante MCP, ou si son
périmètre de permissions est nettement plus adapté. Le nom du package ne constitue jamais une preuve
de son mode d'accès ou de ses capacités.

Cette étape est terminée lorsqu'une candidate domine sur les capacités indispensables et qu'aucune
différence restante ne changerait le choix.

## 3. Décider ou faire choisir

Choisis directement quand une candidate domine clairement. Présente au plus deux options lorsque le
choix dépend d'une préférence humaine, par exemple rapidité de connexion contre couverture plus large.
Pour chaque option, nomme le compromis concret et recommande-en une.

Déclenche ensuite le parcours de connexion décrit par le MCP. Les secrets sont saisis dans la surface
de connexion hébergée prévue à cet effet. Si aucun connecteur adéquat n'existe, formule le manque comme
un besoin de package distinct. Charge un guide d'authoring spécialisé seulement s'il est réellement
présent dans l'index des assistant skills. Sinon, propose ce chantier séparément sans inventer de
guide, d'opération ou de capacité.

Le choix est terminé lorsque le connecteur retenu est nommé avec sa justification, ou lorsqu'un choix
utilisateur précis ou un manque de capacité bloque la suite.
