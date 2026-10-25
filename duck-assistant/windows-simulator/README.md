# Praten met de browsersimulator op Windows 11

Deze uitbreiding voegt een Nederlands spraakgesprek, snavelanimatie en hoofd-/nekreacties
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
en voegt de knoppen, snavelkoppeling en koppeling aan de bestaande hoofdsturing toe.
Opnieuw installeren of een snavel-only versie upgraden is toegestaan.
Een onbekende snavel- of hoofdimplementatie breekt de installatie af voordat bronbestanden
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

**Hoofd en nek bewegen mee** en **Lichaam beweegt mee** kunnen apart aan of uit.
Met **Sterkte beweging** kies je 1× tot 4×; standaard staat dit op 3×.
Tijdens spreken beweegt de kop met het volume en de bestaande expressieve
zangbeweging. De romp wiegt en buigt rustig mee en maakt een kleine op-en-neer-
beweging. Tijdens luisteren kantelt de kop en neemt de romp een rustige houding aan.

Voor rompbewegingen schakelt de simulator bij stilstaan naar zijn bestaande
`BEST_alpha_stand.onnx`: het getrainde staande/body-pose model. Dit stuurt de
benen via de normale policy en physics; het model wordt niet alleen visueel
verschoven. Bij Stop of het uitzetten van lichaamsbewegingen gaat de houding
geleidelijk naar neutraal voordat de gewone walking-policy terugkomt.

Lopen, handmatige hoofdbesturing, trucs, oppakken, herstel, scripts en community-
policies krijgen meteen voorrang. Tijdens die acties zijn gespreksbewegingen
uitgeschakeld; er worden geen bewegingen opgespaard. De Rust-robotcode wordt
hiermee niet aangepast. Stabiliteit en zichtbaarheid moeten in de simulator
worden gecontroleerd.

Bij duidelijke bevestigingen zoals “ja”, “inderdaad” en “dat klopt” knikt de kop.
Bij ontkenningen zoals “nee”, “zeker niet” en “dat klopt niet” schudt de kop.
De herkenning gebruikt de openingszin van de gesproken antwoordtekst. Citaten,
vragen en onzekere of onherkende formuleringen krijgen geen ja/nee-gebaar.
Het gebaar begint zodra de tekst bekend is en de antwoordaudio hoorbaar wordt;
dit is bij benadering, niet exact per woord gesynchroniseerd. Er is maximaal één
ja/nee-gebaar per antwoord. Onderbreken, Stop en handmatige bediening wissen het
gebaar. Het vinkje voor hoofd-/nekbeweging schakelt ook deze gebaren uit.

Probeer bijvoorbeeld “Is twee plus twee vier?” en daarna “Is twee plus twee vijf?”.
De duck hoort bij het bevestigende antwoord te knikken en bij het ontkennende
antwoord te schudden. De lichaamsbeweging en spraak blijven daarbij doorlopen.

De microfoon blijft open zolang het gesprek actief is. Een nieuw gestart gesprek
begint met een lege sessie. Deze versie heeft geen weer-, zoek- of andere tools.

De stem gebruikt `verse`, met instructies voor een lichte, iets hogere, warme en
speelse eendenstem. Hoe dit klinkt moet je beluisteren; de toonhoogte is geen vaste
audio-instelling. Na een update van `session.json` moet je de hulpserver opnieuw
starten en een nieuw gesprek beginnen.

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
