# Run with: . .\use-node.ps1
# Puts this project's Node first on PATH for the current terminal only.
$env:Path = (Join-Path $PSScriptRoot ".tools\node-v22.23.4-win-x64") + ";" + $env:Path
node -v
