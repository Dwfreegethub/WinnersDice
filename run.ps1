# Wrapper script: keeps WinnersDice running, restarting it if the process exits/crashes.
# Usage: .\run.ps1             (runs master branch)
#        .\run.ps1 -Branch dev (runs dev branch)
param(
    [string]$Branch = "master"
)

$ErrorActionPreference = "Continue"

Write-Host "Checking out branch: $Branch"
git checkout $Branch

Write-Host "Building..."
npm run build

while ($true) {
    $time = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Write-Host "[$time] Starting WinnersDice ($Branch)..."

    node build/index.js >> wrapper.output 2>&1

    $exitCode = $LASTEXITCODE
    $time = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Write-Host "[$time] WinnersDice exited with code $exitCode. Restarting in 10 seconds..."

    Start-Sleep -Seconds 10
}
