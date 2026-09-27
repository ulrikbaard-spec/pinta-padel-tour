# 🎾 Pinta Padel Tour

En minimalistisk, blixtsnabb och ren webbapplikation för padelturneringar med 8 spelare på 2 banor (7 omgångar). 
Byggd från grunden med mobil-först-fokus och designad enligt principerna i `frontend-design`.

## ✨ Funktioner

- **Klotterfri & Mobiloptimerad UI:**
  - En enda ren rad i headern (inga staplade banners).
  - Fast iOS-liknande bottenmeny (`Spelare`, `Matcher`, `Tabell`, `Meny`) med fullt stöd för iPhone safe-area insets.
  - Hög kontrast med tabell-siffror (`font-variant-numeric: tabular-nums`) för omedelbar avläsning på banan.
- **Turneringsmotor (8 spelare, 2 banor, 7 omgångar):**
  - Balanserat spelschema där alla spelar med alla en gång och möter alla två gånger.
  - Poängsystem: Game-räkning (standard) eller Americano 32p.
  - Lottningen kan inte göras om av misstag när den väl är genomförd.
- **100% Utan Mail & Lösenord:**
  - Spelare anger bara sitt förnamn och får en 4-siffrig PIN-kod.
  - Arrangören får automatisk kontroll via lokal `adminKey` och kort kod (`PT-xx`).
  - Arrangören förblir inloggad som arrangör när vänner läggs till på plats 2–8.
- **Realtidssynk utan backend:**
  - `localStorage` för full offline-persistens.
  - `BroadcastChannel` för direkt synk mellan flikar på samma enhet.
  - **Paho MQTT over WebSockets** mot HiveMQ för realtidsuppdatering mellan spelarnas mobiler.
- **Arkiv, Papperskorg & Ångra:**
  - Mjuk radering med 8 sekunders "Ångra ↺"-toast.
  - Komplett nollställning vid radering med automatisk övergång till Startskärmen.

## 🚀 Kom igång

Öppna `index.html` i valfri modern webbläsare eller kör via en lokal webbserver:

```bash
# Kör med lokal server:
npx serve .
# eller öppna direkt:
start index.html
```

## 🛠️ Teknikstack

- **HTML5 & Vanilla CSS3:** Minimalistiskt mörkt tema (`#0a0f0d`, `#121916`, `#00e676`), `Plus Jakarta Sans`, touch-optimerade element.
- **Vanilla JavaScript (ES6+):** Rent, modulärt och snabbt utan ramverks-overhead.
- **Paho MQTT:** WebSocket-klient för realtidsdelning.
- **Web Audio API:** Diskreta systemljud genererade direkt i webbläsaren.
