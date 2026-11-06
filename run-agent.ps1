# Keeps the live agent running until this window is closed.
# Start it with: powershell -ExecutionPolicy Bypass -File run-agent.ps1
# While the window is open, Windows won't go to sleep (the screen can still turn off).
# Closing a laptop lid can still sleep the machine, depending on its power settings.
Set-Location $PSScriptRoot
$Host.UI.RawUI.WindowTitle = "Understudy live agent (close to stop)"

Add-Type -Namespace Understudy -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
# ES_CONTINUOUS | ES_SYSTEM_REQUIRED, released automatically when this window closes.
[Understudy.Power]::SetThreadExecutionState(0x80000001) | Out-Null

New-Item -ItemType Directory -Force "data\agent\live" | Out-Null
while ($true) {
  Write-Host "$(Get-Date -Format u) Understudy live agent running. Log: data\agent\live\agent.log"
  # cmd does the redirect so the log stays UTF-8 and is appended to, not replaced.
  cmd /c '".tools\node-v22.23.4-win-x64\node.exe" --env-file=.env src\agent.mjs --live >> data\agent\live\agent.log 2>&1'
  cmd /c "echo %date% %time% agent exited with code $LASTEXITCODE, restarting in 30 seconds >> data\agent\live\agent.log"
  Start-Sleep -Seconds 30
}
