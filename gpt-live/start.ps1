$ErrorActionPreference = 'Stop'
if (-not $env:OPENAI_API_KEY) { $env:OPENAI_API_KEY = Read-Host 'OpenAI API key' }
Write-Host 'Microduck GPT-Live starten op http://127.0.0.1:8787'
node "$PSScriptRoot/server.mjs"
