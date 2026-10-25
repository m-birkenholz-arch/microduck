param([switch]$GoogleSearch, [switch]$RestartHelper)
$ErrorActionPreference = 'Stop'
# Check before asking for keys; optionally replace only this simulator's helper.
$duckListeners = @(Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue)
if ($duckListeners.Count -gt 0) {
    if (-not $RestartHelper) { throw 'Poort 8787 is bezet. Sluit de oude gesprekshulp of start met -RestartHelper.' }
    foreach ($duckProcessId in ($duckListeners | Select-Object -ExpandProperty OwningProcess -Unique)) {
        $duckProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $duckProcessId"
        if ($duckProcess.Name -ne 'node.exe' -or $duckProcess.CommandLine -notlike '*duck-conversation-tools*server.mjs*') {
            throw 'Poort 8787 hoort niet bij de herkenbare Microduck-gesprekshulp. Dit proces wordt niet gestopt.'
        }
        Stop-Process -Id $duckProcessId -ErrorAction Stop
    }
    Start-Sleep -Milliseconds 300
    if (Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue) { throw 'Poort 8787 is nog bezet. Probeer opnieuw.' }
}
$previousKey = $env:OPENAI_API_KEY
$previousGoogleKey = $env:GOOGLE_API_KEY
try {
    if (-not $env:OPENAI_API_KEY) {
        Write-Host 'Vul je OpenAI API-key hieronder in. Deel deze niet in de chat.'
        Write-Host 'De key wordt niet getoond en niet in een bestand opgeslagen.'
        $secureKey = Read-Host 'OpenAI API-key (plakken en Enter)' -AsSecureString
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
        try { $env:OPENAI_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer); $secureKey.Dispose() }
    }
    if ($GoogleSearch -and -not $env:GOOGLE_API_KEY -and -not $env:GEMINI_API_KEY) {
        Write-Host 'Vul je Google AI Studio API-key in voor Google Search en beeldanalyse. Deel deze niet in de chat.'
        $secureGoogleKey = Read-Host 'Google API-key (plakken en Enter)' -AsSecureString
        $googlePointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureGoogleKey)
        try { $env:GOOGLE_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($googlePointer) }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($googlePointer); $secureGoogleKey.Dispose() }
    }
    Write-Host 'Laat de simulator en dit venster openstaan. Stop het gesprek met de Stop-knop.'
    & node.exe (Join-Path $PSScriptRoot 'server.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Gesprekshulp is gestopt met een fout.' }
}
finally { $env:OPENAI_API_KEY = $previousKey; $env:GOOGLE_API_KEY = $previousGoogleKey }
