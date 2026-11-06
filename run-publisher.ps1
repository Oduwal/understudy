# Republishes the hosted dashboard snapshot every hour until this window is closed.
# Start it with: powershell -ExecutionPolicy Bypass -File run-publisher.ps1
Set-Location $PSScriptRoot
$Host.UI.RawUI.WindowTitle = "Understudy dashboard publisher (close to stop)"
New-Item -ItemType Directory -Force "data" | Out-Null
while ($true) {
  cmd /c '".tools\node-v22.23.4-win-x64\node.exe" scripts\publish-site.mjs >> data\publish.log 2>&1'
  Start-Sleep -Seconds 3600
}
