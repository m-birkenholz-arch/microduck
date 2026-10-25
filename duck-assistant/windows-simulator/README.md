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

De basisstem is nu `marin`, met een warme, natuurlijke vrouwelijke stem en
rustige spreekinstructies voor een **moeder-eend**. **Stemhoogte** begint op 0:
geen hoge stemvervorming, zodat de natuurlijke klank behouden blijft. De schuif
0..9 blijft beschikbaar als je haar wat hoger wilt laten klinken. Bij deze update
worden de oude hoge stemstand en het karakter eenmalig naar 0 en Moeder-eend
omgezet; naam, herinneringen en overige instellingen blijven behouden. Latere
handmatige aanpassingen worden zoals gewoonlijk bewaard.

Onder **Karakter** staat **Warme moeder-eend**. Zij krijgt instructies om geduldig
te adviseren en uit te leggen, met eenvoudige taal en kleine pauzes. Bij huiswerk
helpt zij ontdekken waar iemand vastloopt, geeft een hint of één stap tegelijk
en gebruikt voorbeelden op het niveau van de leerling. Op verzoek kan ze een
uitgewerkt voorbeeld geven. Dit is gestuurd modelgedrag; probeer de klank en de
uitleg in een live gesprek, de tests beoordelen geen echte stemopname.

Met **Help met huiswerk** start je een nieuw gesprek en wordt de gespreksstijl
**Huiswerkhulp** bewaard. Zij hoort eerst om het vak/de opgave te vragen. Je kunt
ook gewoon om huiswerkhulp vragen tijdens een gesprek. Een bewust gekozen foto
kan nu ook een opgave bevatten; in huiswerkstand krijgt ze specifieke instructies
om eerst de leesbare opgave te begrijpen en niets te gokken bij onleesbare tekst.
Eenvoudige reken- en taaloefeningen hoeven niet via Google; naslag en actuele
vragen blijven opzoekbaar. Foto's blijven eenmalige gedeelde beelden.

Stemhoogte, volume en bewegingen worden lokaal bewaard. De toonhoogtevervorming
bij een stand boven 0 kan maximaal ongeveer 68 ms vertraging en een wat korrelige
klank toevoegen; op 0 wordt het signaal direct doorgegeven. Na deze update moet
de hulpserver opnieuw starten en een nieuw gesprek beginnen om ook de nieuwe
basisinstructies te laden. De fysieke robot krijgt dezelfde basisstemconfiguratie,
maar de browserbediening en het huiswerkprofiel zijn nog niet op hardware getest.

## Naam, geheugen, ochtendpraatje en natuurmaatje

Onder **Mijn eendje en instellingen** geef je de duck een naam, vul je eventueel
je eigen naam, interesses en weerplaats in en kies je Nieuwsgierig, Rustig of
Speels. **Bewaar instellingen** bewaart dit lokaal in deze browser. Stemhoogte,
volume, bewegingssterkte en beide bewegingsvinkjes worden direct bewaard.
Instellingen horen bij browserprofiel én origin: gebruik steeds dezelfde browser
en hetzelfde adres (bijvoorbeeld `http://localhost:5173`). Privémodus of het wissen
van sitegegevens kan ze verwijderen. Er staat geen kopie van persoonlijke gegevens
in GitHub. Geblokkeerde of volle browseropslag geeft een foutmelding.

**Goedemorgen** start een nieuw gesprek met een kort ochtendpraatje. De ingestelde
plaats kan voor het weer worden gebruikt, met een natuur- of wetenschapsfeitje en
een vraag naar je plannen. Zonder plaats hoort hij daar eerst naar te vragen.
Ook “goedemorgen” tijdens een gewoon gesprek krijgt deze instructie. Er is geen
klokgestuurde taak of automatische dagelijkse aankondiging.

Het karakter stelt soms een passende vervolgvraag. **Natuurmaatje** richt het
gesprek op dieren, planten en natuurverschijnselen, met Google voor feitelijke
naslag. Naast ja/nee-gebaren kunnen duidelijke uitingen als “Wat leuk!” of
“Wat vind jij daarvan?” een enthousiaste beweging of nieuwsgierige kanteling
geven. De bestaande bewegingsgrenzen en handmatige voorrang blijven gelden.

Onder **Wat onthoud ik?** kun je maximaal 30 herinneringen bekijken, zelf toevoegen,
los verwijderen of allemaal wissen. Je kunt ook zeggen **“Onthoud dat ik van
vogels houd”**, **“Wat heb je van mij onthouden?”** of vragen een specifieke
herinnering te vergeten. De modelinstructies staan opslaan alleen toe bij een
expliciet verzoek; de functie vereist ook een expliciete-verzoekvlag. Geen
achtergrondextractie of volledig gespreksarchief. Veelgebruikte sleutel- en
wachtwoordpatronen worden geweigerd; zet zelf geen geheimen in vrije tekst.
Alleen geslaagde opslag mag als bewaard worden bevestigd.

Instellingen en herinneringen staan als leesbare gegevens in localStorage, niet
in een versleutelde kluis. Bij een nieuw gesprek gaan naam, interesses, plaats en
het ingeschakelde geheugen naar OpenAI. Het volledige geheugen gaat niet naar
Google, maar een door het model geformuleerde zoekvraag kan wel relevante context
bevatten. **Geheugen gebruiken** uitzetten houdt opgeslagen notities lokaal maar
stuurt ze bij het volgende gesprek niet mee. De UI sluit bij uitzetten/verwijderen
het lopende gesprek af om geen oude persoonlijke context te blijven gebruiken.
Verwijderen is geen verzoek om eerder bij providers verwerkte gegevens te wissen.

### Wekwoord

Klik eenmaal op **Wacht op hé Duck** (of de gekozen naam). De browser vraagt zo
nodig om microfoontoegang. Zeg daarna **“Hé Duck”** of **“Hé Duck, hoe werkt een
motor?”**. Na herkenning stopt de wekwoordherkenner en start de gewone Realtime-
verbinding; een vraag achter de naam wordt als tekst meegenomen. Voor terugkeer
naar luisterstand klik je weer op **Wacht op hé …**. **Stop alles** sluit zowel
Realtime als de wekwoordmicrofoon en de voorbereide audio-context af.

Dit gebruikt `SpeechRecognition`/`webkitSpeechRecognition` waar beschikbaar in
Chrome of Edge. De browser kan audio voor herkenning naar zijn eigen online
dienst sturen, ook vóór een wekwoord wordt herkend. Het is geen gegarandeerd
lokaal of offline wekwoord. Fouten in toestemming, netwerk of ondersteuning
stoppen de herkenner met een melding; **Start gesprek** blijft beschikbaar.
Wekwoordluisteren begint nooit automatisch na herladen, en verbergen van de tab
stopt alle luisterstanden. In een open tab kan de browser de herkenning alsnog
onderbreken. Windows-gedrag en herkenningskwaliteit moeten live worden getest.

### Natuurfoto en camera

Onder **Samen de natuur ontdekken** kun je bewust één JPG-, PNG- of WebP-foto
kiezen (maximaal 8 MB). De browser verkleint die tot een JPEG-bericht van maximaal
48.000 tekens en deelt die in een nieuw Realtime-gesprek met OpenAI. De foto wordt
niet in localStorage of GitHub bewaard. De duck krijgt instructies onzekerheid bij
herkennen te benoemen en geen opdrachten uit tekst op de foto te volgen.

De camera in de browsersimulator is een virtuele scènecamera; hij levert geen
beeld van je kamer of echte dieren. De fysieke robot publiceert camera en control
via de bestaande WebRTC-interface. Die stream en de instellingen/motorbesturing
moeten later op het echte apparaat worden aangesloten en getest. Foto-input is nu
een eerste simulatorproef, geen continue fysieke camera-integratie.

## Laptopcamera en gezichtsherkenning

Dit is een lokale test voor het herkennen van bewust aangeleerde gezichten.
Klik bovenaan **Camera testen**, open zo nodig de sectie **Laptopcamera en
gezichtsherkenning**, en klik **Camera starten**. Geef de browser cameratoegang.
Deze aanvraag vraagt alleen video, geen extra microfoon. De bestaande spraak-
verbinding kan tegelijk blijven werken.

De eerste installatie vereist `install.ps1 -FaceCamera` (eventueel samen met
`-GoogleSearch -RestartHelper`). De installer downloadt circa 8 MB aan vaste
face-api.js 0.22.2-bestanden uit één upstream Git-commit, controleert SHA-256 en
bewaart ook de licentie. De bestanden worden onder `app/public/duck-face` lokaal
geserveerd. Browserherkenning doet geen modeldownloads naar een externe CDN en
stuurt geen camerabeelden naar een cloudservice. Er is geen extra API-key nodig
voor de camerafunctie. Ontbreken de modellen, dan geeft Camera starten een melding
om met `-FaceCamera` te installeren. Latere gewone updates behouden de modellen.

Zo leer je je gezicht aan:

1. Ga alleen voor de camera zitten, met goed licht en het gezicht recht naar voren.
2. Wacht tot **Leer mijn gezicht** beschikbaar wordt (drie duidelijke metingen).
3. Vul je naam in en klik **Leer mijn gezicht**. Er wordt een profiel lokaal
   bewaard met je naam en drie reeksen getallen, geen foto's of video.
4. Wacht op **Lijkt op [naam] (herkenningsproef)**. Onbekende, onduidelijke of
   te sterk op elkaar lijkende gezichten krijgen geen naam. Bij meerdere gezichten
   wordt geen naam gekozen en kun je niet aanleren.

Er passen maximaal vijf profielen in **Mijn gezichtsprofielen**. Leer alleen
jezelf aan of iemand die hiervoor toestemming geeft. Namen en numerieke
gezichtsprofielen staan als leesbare gegevens apart in localStorage van deze
browser/origin. Ze worden niet in GitHub of het gewone gesprekgeheugen opgeslagen.
Je kunt losse profielen verwijderen of **Wis alle gezichtsprofielen** gebruiken;
verwijderen stopt ook de cameraloop om oude herkenning direct te wissen.

Wil je dat moeder-eend je herkent tijdens het praten? Zet bewust **Duck mag de
herkende naam gebruiken** aan. Vraag dan **“Herken je mij?”**, of klik **Laat Duck
mij begroeten** om een nieuw gesprek te starten. De lokale statusfunctie geeft
alleen of de camera aanstaat, het aantal gezichten en na deze toestemming een
mogelijke naam terug aan OpenAI. Zij ontvangt geen videobeeld, foto of descriptor.
Zonder dit vinkje blijven namen lokaal; aantallen en camera-aan/uit kunnen wel
worden uitgelezen. Er worden geen spontane herkenningsberichten of begroetingen
gestuurd. Een naam die al besproken is kan in het lopende gesprek blijven staan;
uitzetten/wissen verwijdert geen historische providergegevens.

**Camera stoppen** sluit alleen video af. **Stop alles**, tab verbergen, herladen
of sluiten stopt ook de camera, eventuele herkenningslus en naamdeling. De camera
begint nooit vanzelf opnieuw en het naamdelen staat na stoppen weer uit. De
camerafunctie werkt los van de Google-key; de begroeting/gesprekken vereisen wel
de gewone gesprekshulp met OpenAI-key.

De melding **Illegal invocation** uit de eerste cameraversie kwam door een
browser-timer die als methode van de cameraklasse werd aangeroepen. De
herkenning liep daardoor na de eerste meting vast en Aanleren bleef uit. De
native browser-timers worden nu via hun eigen Window-object aangeroepen; ook de
herstarttimer van het wekwoord gebruikt die correctie. De gezichtsprofielen en
camera-/naamtoestemming veranderen hierdoor niet.

Sluit de camera kort na starten? De camerabeelden blijven nu aan als alleen de
herkenning faalt. De herkenner wacht op een bruikbaar videoframe en gebruikt een
lokale canvas-kopie van het beeld. Bij een GPU-fout probeert hij één keer de CPU
met opnieuw geladen lokale modelgewichten. Dat kan trager zijn. Als ook dat niet
lukt, verschijnt **Herkenning gepauzeerd** met de oorzaak en de knop
**Herkenning opnieuw proberen**. Die hergebruikt dezelfde camera; je hoeft niet
steeds opnieuw toestemming te geven. Er worden geen namen uit een mislukte of
oude herkenning gedeeld. Een fout bij het tekenen van het optionele gezichtskader
heeft geen invloed meer op camera of herkenning.

Houd de simulatortab zichtbaar. Naar een andere tab gaan, minimaliseren, Stop
alles of een door Windows beëindigde cameratrack sluit de camera nog steeds af.
Bij het verbergen van de tab of een beëindigde track wordt de reden getoond.
Mocht het blijven misgaan, geef de exacte melding onder het camerabeeld door.
Deze reparatie wijzigt geen gezichtsprofielen of naamdeling.

Dit is geen beveiligings- of identiteitscontrole: licht, pose en camera beïnvloeden
het resultaat, een foto kan voor een echt gezicht doorgaan en herkenning kan
fouten maken. Er wordt geen leeftijd, geslacht, emotie of andere persoonskenmerk
bepaald. De fysieke robotcamera en gezichtsafhankelijke motorreacties zijn nog
niet aangesloten. Test nu eerst je laptopcamera in Chrome of Edge op localhost.
Als openen niet lukt: controleer cameratoestemming in de browser en Windows en
sluit eventueel andere camera-apps.

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

De nieuwe naam-/geheugenfuncties vereisen de bijgewerkte hulpserver; herstart
na deze update. Met `start.ps1 -GoogleSearch -RestartHelper` kan de launcher eerst
een herkenbare oude `node.exe ...duck-conversation-tools...server.mjs` op poort
8787 stoppen. Andere processen worden geweigerd. De poortcontrole gebeurt vóór
het vragen om keys, zodat een bezette poort geen onnodige invoerronde kost.

De hulpserver gebruikt alleen `127.0.0.1:8787`. Sluit een oude hulpserver als deze
poort bezet is. Open de simulator op poort 5173; andere origins worden geweigerd.
`DUCK_OPENAI_MODEL` kan het bestaande standaardmodel `gpt-realtime-2.1` overriden.
De API-key moet bij je eigen OpenAI-project horen en dat project moet voldoende
API-tegoed en modeltoegang hebben.

## Ontwikkelen en testen

Vanuit de root van de robotrepository:

```sh
node --test duck-assistant/windows-simulator/conversation.test.mjs duck-assistant/windows-simulator/search.test.mjs duck-assistant/windows-simulator/companion.test.mjs duck-assistant/windows-simulator/face.test.mjs
node duck-assistant/windows-simulator/install.mjs /pad/naar/microduck-simulator
```

De tests gebruiken een nagemaakte OpenAI-verbinding en browseraudio, geen API-key.
Ze controleren de SDP-uitwisseling, key-afscherming, installatie, sessieprofiel,
barge-in en cleanup, inclusief Stop tijdens een open microfoondialoog.
Een echte Windows-microfoon en een live OpenAI-gesprek moeten op de laptop worden
gecontroleerd. De Rust-robotcode wordt door deze uitbreiding niet aangepast.
