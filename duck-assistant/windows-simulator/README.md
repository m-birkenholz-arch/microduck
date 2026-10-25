# Praten met de browsersimulator op Windows 11

Deze uitbreiding voegt een Nederlands spraakgesprek en cosmetische snavelanimatie
toe aan een lokale kopie van de officiële
[Microduck-browsersimulator](https://huggingface.co/spaces/pollen-robotics/microduck-simulator).
De [gespreksarchitectuur](../../docs/design/conversation-design.md#windows-browser-test)
beschrijft de verbinding en welke onderdelen van de echte robot hiermee niet worden getest.

## Installeren

Vereist: de simulator draait al op `http://localhost:5173`, Node.js 22+,
Chrome of Edge, een microfoon en een OpenAI API-key met toegang tot het ingestelde
Realtime-model. API-gebruik wordt apart van een ChatGPT-abonnement afgerekend.
Gebruik bij voorkeur een koptelefoon.

Open een **tweede PowerShell-venster**; laat het Vite-venster open.
Download `install.ps1` uit deze map en voer het uit:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -SimulatorPath "$env:USERPROFILE\microduck-simulator"
```

De execution policy geldt alleen voor dat proces. De installer downloadt de
bestanden uit één vaste commit op `feature/conversation`, bewaart de originele
`app/index.html` en `app/src/game/game.js` als `.before-conversation`-bestanden,
en voegt de knoppen en de snavelkoppeling toe. Opnieuw installeren is toegestaan.
Een onbekende snavelimplementatie breekt de installatie af voordat bronbestanden
worden aangepast.

Plak je API-key in de verborgen PowerShell-invoer en druk op Enter. Er verschijnen
geen tekens tijdens het invoeren. De key staat alleen in het procesgeheugen en
wordt niet naar de browser gestuurd of in een bestand opgeslagen.

Ververs `http://localhost:5173`. Rechtsboven staat **Praat met Microduck**:

1. Klik op **Start gesprek** en geef de browser microfoontoegang.
2. Wacht op **Verbonden — praat maar**.
3. Zeg bijvoorbeeld: “Goedemorgen, hoe gaat het?”
4. Praat door een antwoord heen om onderbreken te proberen.
5. Klik op **Stop** om de verbinding en de microfoon af te sluiten.

De microfoon blijft open zolang het gesprek actief is. Een nieuw gestart gesprek
begint met een lege sessie. Deze versie heeft geen weer-, zoek- of andere tools.

## Later opnieuw starten

Start de simulator zoals gewoonlijk met `npm.cmd run dev` in zijn `app`-map.
Open daarnaast PowerShell en voer uit:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\microduck-simulator\duck-conversation-tools\start.ps1"
```

De hulpserver gebruikt alleen `127.0.0.1:8787`. Sluit een oude hulpserver als deze
poort bezet is. Open de simulator op poort 5173; andere origins worden geweigerd.
`DUCK_OPENAI_MODEL` kan het bestaande standaardmodel `gpt-realtime-2.1` overriden.
De API-key moet bij je eigen OpenAI-project horen en dat project moet voldoende
API-tegoed en modeltoegang hebben.

## Ontwikkelen en testen

Vanuit de root van de robotrepository:

```sh
node --test duck-assistant/windows-simulator/conversation.test.mjs
node duck-assistant/windows-simulator/install.mjs /pad/naar/microduck-simulator
```

De tests gebruiken een nagemaakte OpenAI-verbinding en browseraudio, geen API-key.
Ze controleren de SDP-uitwisseling, key-afscherming, installatie, sessieprofiel,
barge-in en cleanup, inclusief Stop tijdens een open microfoondialoog.
Een echte Windows-microfoon en een live OpenAI-gesprek moeten op de laptop worden
gecontroleerd. De Rust-robotcode wordt door deze uitbreiding niet aangepast.
