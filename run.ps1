# Wrapper script: keeps WinnersDice running, restarting it if the process exits/crashes.
$ErrorActionPreference = "Continue"

while ($true) {
    $time = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Write-Host "[$time] Starting WinnersDice..."

    node build/index.js >> wrapper.output 2>&1

    $exitCode = $LASTEXITCODE
    $time = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Write-Host "[$time] WinnersDice exited with code $exitCode. Restarting in 10 seconds..."

    Start-Sleep -Seconds 10
}
