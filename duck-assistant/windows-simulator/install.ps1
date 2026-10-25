param(
    [string]$SimulatorPath = (Join-Path $env:USERPROFILE 'microduck-simulator'),
    [string]$Ref = 'feature/conversation',
    [switch]$GoogleSearch,
    [switch]$RestartHelper,
    [switch]$FaceCamera,
    [switch]$SpeakerRecognition
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
if (-not (Test-Path (Join-Path $SimulatorPath 'app\src\game\game.js'))) {
    throw "Geen simulator gevonden in $SimulatorPath"
}
$node = Get-Command node.exe -ErrorAction Stop
$nodeMajor = [int]((& $node.Source --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 22) { throw 'Installeer eerst Node.js LTS (versie 22 of hoger).' }
# Resolve once so all downloaded files belong to the same reviewed revision.
if ($Ref -notmatch '^[a-f0-9]{40}$') {
    $escapedRef = [Uri]::EscapeDataString($Ref)
    $commit = Invoke-RestMethod -Uri "https://api.github.com/repos/m-birkenholz-arch/microduck/commits/$escapedRef" -Headers @{ 'User-Agent' = 'microduck-conversation-installer' }
    $Ref = $commit.sha
}
if ($Ref -notmatch '^[a-f0-9]{40}$') { throw 'Kon de installatieversie niet bepalen.' }
$tools = Join-Path $SimulatorPath 'duck-conversation-tools'
New-Item -ItemType Directory -Force -Path $tools | Out-Null
$base = "https://raw.githubusercontent.com/m-birkenholz-arch/microduck/$Ref/duck-assistant/windows-simulator"
foreach ($name in @('speaker-local.mjs', 'speaker-panel.mjs', 'speaker-worklet.mjs', 'speaker-worker.mjs', 'speaker-backend.mjs', 'speaker-setup.mjs', 'speaker-package.json', 'speaker-notices.md', 'server.mjs', 'search-google.mjs', 'vision-google.mjs', 'vision.mjs', 'session.json', 'client.mjs', 'panel.mjs', 'mouth.mjs', 'motion.mjs', 'gestures.mjs', 'voice.mjs', 'voice-worklet.mjs', 'search-tools.mjs', 'companion.mjs', 'wake.mjs', 'photo.mjs', 'face-local.mjs', 'face-engine.mjs', 'face-panel.mjs', 'face-assets.mjs', 'face-assets.json', 'install.mjs', 'start.ps1')) {
    Invoke-WebRequest -UseBasicParsing -Uri "$base/$name" -OutFile (Join-Path $tools $name)
}
if ($SpeakerRecognition) {
    Write-Host 'Lokaal stemmodel en herkenningspakket installeren...'
    & $node.Source (Join-Path $tools 'speaker-setup.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Stemherkenning installeren mislukt. Zie de fout hierboven.' }
}
if ($FaceCamera) {
    Write-Host 'Lokale gezichtsmodellen installeren (ongeveer 8 MB, geen API-key nodig)...'
    & $node.Source (Join-Path $tools 'face-assets.mjs') $tools
    if ($LASTEXITCODE -ne 0) { throw 'Gezichtsmodellen konden niet worden geinstalleerd. Probeer de update opnieuw.' }
}
& $node.Source (Join-Path $tools 'install.mjs') $SimulatorPath
if ($LASTEXITCODE -ne 0) { throw 'Installatie afgebroken. Zie de fout hierboven.' }
Write-Host "Geinstalleerd uit commit $Ref"
Write-Host 'Ververs straks http://localhost:5173. Rechtsboven verschijnt Praat met Microduck.'
& (Join-Path $tools 'start.ps1') -GoogleSearch:$GoogleSearch -RestartHelper:$RestartHelper
