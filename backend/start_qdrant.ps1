$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Test-Path -LiteralPath '.cache/qdrant/bin/qdrant.exe')) {
    throw 'Qdrant binary not installed. Use Docker Qdrant or the verified official Windows release.'
}
& .cache/qdrant/bin/qdrant.exe --config-path qdrant-local.yaml
