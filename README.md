# 🎾 Pinta Padel Tour

En modern, responsiv och interaktiv webbapplikation för padelturneringar med 8 spelare.

## ✨ Funktioner

- **Turneringsmotor för 8 spelare:**
  - **Alternativ 1 (Lag-serie):** 7 omgångar × 3 matcher. I varje omgång bildas 4 lag som möter varandra i seriespel. Alla spelar med varje medspelare (21 matcher per spelare).
  - **Alternativ 2 (Bana-rotation):** 4 spelare på bana 1 och 4 på bana 2 hela omgången, med intern rotation.
- **Poängsystem:**
  - Standard: **Game-räkning** (vunna game, t.ex. 6–4, 6–2).
  - Americano (32 poäng per match).
  - Snabbturnering (24 poäng per match).
- **Smart arrangörshantering:**
  - Skaparen av turneringen auktoriseras automatiskt på sin enhet via en unik arrangörsnyckel (`adminKey`) och kort kod (`PT-xx`). Inga hårdkodade PIN-koder behövs.
  - Arrangören kan automatiskt placeras på Plats 1 vid skapandet.
  - Tvådelade inbjudningslänkar: publika deltagarlänkar för vänner (visningsläge/anmälan) och personliga arrangörslänkar för styrning från t.ex. iPad eller dator.
- **Realtid & Delning:**
  - Inbjudningslänkar för Messenger, WhatsApp, Gmail och e-post.
  - Möjlighet att maila alla anmälda deltagare med ett klick (BCC).
  - Liveresultat och tabell (matcher, vinster, poängskillnad).
  - Realtidssynkning över nätet via MQTT och lokalt via BroadcastChannel.
- **Arkiv & Papperskorg:**
  - Återställningsbar papperskorg med ångra-toast vid radering av turneringar.

## 🚀 Kom igång

Öppna helt enkelt `index.html` i valfri modern webbläsare eller kör via en lokal webbserver:

```bash
# Exempel med valfri lokal server:
npx serve .
# eller öppna direkt:
start index.html
```

## 🛠️ Teknikstack

- **HTML5 & Vanilla CSS3:** Modernt mörkt tema med glassmorphism, accentfärger och responsiv layout för mobil, surfplatta och desktop.
- **Vanilla JavaScript (ES6+):** Rent, fristående och snabbt utan tunga externa beroenden.
- **Paho MQTT:** För realtidsuppdatering mellan olika mobiler på banan.
