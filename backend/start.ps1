$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$env:PYTHONUTF8='1'
& .venv/Scripts/python.exe -m scripts.migrate
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& .venv/Scripts/python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 3001
