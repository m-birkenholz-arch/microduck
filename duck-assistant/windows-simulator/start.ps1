param([switch]$GoogleSearch)
$ErrorActionPreference = 'Stop'
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
        Write-Host 'Vul je Google AI Studio API-key in voor Google Search. Deel deze niet in de chat.'
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
