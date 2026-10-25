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
begint met een lege sessie. Google Search is optioneel beschikbaar zoals hieronder beschreven.

De basisstem is `shimmer`. In de browser maakt een lokale stemvervorming de
toonhoogte en klank hoger zonder het spreektempo te verhogen. **Eendenstem**
staat standaard op 5 halve tonen hoger; met de schuif kies je direct tussen
0 (basisstem) en 9 (extra klein en hoog), ook tijdens een gesprek. De instelling
blijft gelden tot de pagina opnieuw geladen wordt. De verwerking voegt maximaal
ongeveer 68 ms vertraging toe en kan een licht korrelige klank geven. Test op je
laptop wat schattig én verstaanbaar klinkt. Er worden geen extra API-aanroepen gedaan.
Na een update van `session.json` moet je de hulpserver opnieuw starten en een nieuw
gesprek beginnen. De lokale stemvervorming geldt voor de browsersimulator; op de
fysieke robot wordt deze nog niet toegepast.

## Google Search inschakelen

Voor kennisvragen (bijvoorbeeld Obama, hoe een motor werkt of het weer) kan de
browsimulator via de lokale hulpserver Google Search raadplegen. OpenAI Realtime
blijft het gesprek en de stem verzorgen. De zoekvraag gaat naar Google via Gemini,
standaard `gemini-3.8-flash`; het resultaat met bronlinks gaat terug naar OpenAI.
Alleen de zelfstandige zoekvraag wordt aan Google verzonden, niet de volledige
microfoonaudio of de volledige gesprekshistorie. API-gebruik bij Google wordt
apart van OpenAI afgerekend; controleer je Google-projectquota en facturering.

1. Maak een Gemini API-key in [Google AI Studio](https://aistudio.google.com/apikey).
2. Stop het gesprek en stop de **oude gesprekshulp** met Ctrl+C. Laat Vite draaien.
3. Start de bijgewerkte helper met:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\microduck-simulator\duck-conversation-tools\start.ps1" -GoogleSearch
   ```

4. Vul de OpenAI-key en daarna de Google-key in de verborgen invoer in. Beide
   blijven alleen in het helperproces; ze worden niet opgeslagen in bestanden,
   browser of logs. Deel ze niet in de chat.
5. Ververs de browser en start een nieuw gesprek. Het paneel meldt
   **Google Search ingeschakeld**.

Vraag bijvoorbeeld “Zoek op wie Barack Obama was” of “Hoe werkt fotosynthese?”.
Bij weer zonder bekende plaats hoort de duck eerst naar de plaats te vragen.
Tijdens de zoekopdracht staat er “Ik zoek het op met Google…”. Daarna gebruikt de
duck de gevonden informatie en toont het paneel het opgezochte antwoord,
bronlinks en de meegeleverde Google Search-suggesties. Deze bronnen horen bij het
opgezochte materiaal; de gesproken samenvatting kan anders geformuleerd zijn.

Bij onderbreken wordt de lopende zoekopdracht afgebroken; oude resultaten starten
geen nieuw antwoord. Stop sluit ook het zoeken af. Een zoekfout wordt als fout
teruggegeven aan het model, zodat het eerlijk kan zeggen dat opzoeken niet lukte.
Zonder Google-key blijft gewoon praten werken, maar is Google zoeken uit.
De hulpserver begrenst zoeken op één opdracht tegelijk en tien per minuut; een
antwoord na een zoekresultaat kan niet meteen opnieuw zoeken. Er is geen
achtergrondpolling. `DUCK_GOOGLE_MODEL` kan het zoekmodel overriden. De fysieke
Rust-assistent heeft deze Google-koppeling nog niet.

De installatie ondersteunt ook `install.ps1 -GoogleSearch`. Alleen als deze optie
is opgegeven vraagt de launcher om een ontbrekende Google-key. Bestaande
`GOOGLE_API_KEY` of `GEMINI_API_KEY` procesvariabelen worden gebruikt zonder prompt.

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
node --test duck-assistant/windows-simulator/conversation.test.mjs duck-assistant/windows-simulator/search.test.mjs
node duck-assistant/windows-simulator/install.mjs /pad/naar/microduck-simulator
```

De tests gebruiken een nagemaakte OpenAI-verbinding en browseraudio, geen API-key.
Ze controleren de SDP-uitwisseling, key-afscherming, installatie, sessieprofiel,
barge-in en cleanup, inclusief Stop tijdens een open microfoondialoog.
Een echte Windows-microfoon en een live OpenAI-gesprek moeten op de laptop worden
gecontroleerd. De Rust-robotcode wordt door deze uitbreiding niet aangepast.
