# start_backend.ps1 – Launch FactCheck FastAPI server on Windows

param(
    [string]$ModelPath = ""
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

if ($ModelPath -eq "") {
    $ModelPath = Join-Path $ScriptDir "factcheck-model"
}

Write-Host "────────────────────────────────────────" -ForegroundColor Cyan
Write-Host "  🔍 FactCheck ML Backend" -ForegroundColor Cyan
Write-Host "────────────────────────────────────────" -ForegroundColor Cyan
Write-Host "  Model path : $ModelPath"
Write-Host "  Server     : http://localhost:8000"
Write-Host "────────────────────────────────────────" -ForegroundColor Cyan

if (-Not (Test-Path $ModelPath)) {
    Write-Host ""
    Write-Host "❌ ERROR: Model folder not found at:" -ForegroundColor Red
    Write-Host "   $ModelPath" -ForegroundColor Red
    Write-Host ""
    Write-Host "   Copy your factcheck-model folder into the backend\ directory," -ForegroundColor Yellow
    Write-Host "   or run:  .\start_backend.ps1 -ModelPath C:\path\to\factcheck-model" -ForegroundColor Yellow
    Write-Host ""
    exit 1
}

# Install deps if missing
$fastapi = python -c "import fastapi" 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "📦 Installing Python dependencies..." -ForegroundColor Yellow
    pip install -r "$ScriptDir\requirements.txt"
}

Write-Host ""
Write-Host "🚀 Starting server..." -ForegroundColor Green
Write-Host ""

$env:MODEL_PATH = $ModelPath
Set-Location $ScriptDir
uvicorn app:app --host 0.0.0.0 --port 8000 --reload
