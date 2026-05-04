# ============================================================
# REFINED RECOVERY NETWORK — Railway Backend Deployment
# Run this from the rrn-backend directory
# PowerShell: Right-click → Run with PowerShell
# Or: powershell -ExecutionPolicy Bypass -File deploy.ps1
# ============================================================

param(
    [string]$JwtSecret = "",
    [string]$AllowedOrigins = "https://refinedrecovery.com,https://chuckedwards1972.github.io",
    [switch]$SkipSeed = $false,
    [switch]$SkipSchema = $false
)

$ErrorActionPreference = "Stop"
$BackendDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  REFINED RECOVERY NETWORK — Railway Deployment" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

# ── STEP 0: Verify we're in the right directory ──────────────
Set-Location $BackendDir

if (-not (Test-Path "server.js")) {
    Write-Host "ERROR: server.js not found. Run this script from the rrn-backend directory." -ForegroundColor Red
    exit 1
}

Write-Host "✓ Working directory: $BackendDir" -ForegroundColor Green

# ── STEP 1: npm install ───────────────────────────────────────
Write-Host ""
Write-Host "[1/7] Installing dependencies..." -ForegroundColor Yellow
npm install --omit=dev
if ($LASTEXITCODE -ne 0) { Write-Host "npm install failed" -ForegroundColor Red; exit 1 }
Write-Host "✓ Dependencies installed" -ForegroundColor Green

# ── STEP 2: Railway CLI check ─────────────────────────────────
Write-Host ""
Write-Host "[2/7] Checking Railway CLI..." -ForegroundColor Yellow
$railwayVersion = railway --version 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Railway CLI not found. Installing..." -ForegroundColor Yellow
    npm install -g @railway/cli
    if ($LASTEXITCODE -ne 0) { 
        Write-Host "Failed to install Railway CLI. Install manually: npm install -g @railway/cli" -ForegroundColor Red
        exit 1 
    }
}
Write-Host "✓ Railway CLI ready" -ForegroundColor Green

# ── STEP 3: Railway login check ───────────────────────────────
Write-Host ""
Write-Host "[3/7] Checking Railway authentication..." -ForegroundColor Yellow
$whoami = railway whoami 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Not logged in to Railway. Opening login..." -ForegroundColor Yellow
    railway login
    if ($LASTEXITCODE -ne 0) { Write-Host "Railway login failed" -ForegroundColor Red; exit 1 }
}
Write-Host "✓ Authenticated: $whoami" -ForegroundColor Green

# ── STEP 4: Link to project ───────────────────────────────────
Write-Host ""
Write-Host "[4/7] Linking to Railway project (romantic-enchantment)..." -ForegroundColor Yellow
Write-Host "      If prompted, select project: romantic-enchantment" -ForegroundColor Cyan
Write-Host "      Service: rrn-backend (or create new)" -ForegroundColor Cyan
railway link
if ($LASTEXITCODE -ne 0) { Write-Host "Railway link failed" -ForegroundColor Red; exit 1 }
Write-Host "✓ Project linked" -ForegroundColor Green

# ── STEP 5: Set environment variables ─────────────────────────
Write-Host ""
Write-Host "[5/7] Setting environment variables..." -ForegroundColor Yellow

# Generate JWT secret if not provided
if ($JwtSecret -eq "") {
    Write-Host "      Generating JWT secret..." -ForegroundColor Cyan
    # Use .NET crypto for secret generation (no openssl needed on Windows)
    $bytes = New-Object byte[] 64
    [System.Security.Cryptography.RNGCryptoServiceProvider]::Create().GetBytes($bytes)
    $JwtSecret = [BitConverter]::ToString($bytes).Replace("-", "").ToLower()
    Write-Host "      Generated JWT secret (64 bytes hex)" -ForegroundColor Cyan
}

railway variables set JWT_SECRET="$JwtSecret"
railway variables set JWT_EXPIRES="7d"
railway variables set NODE_ENV="production"
railway variables set ALLOWED_ORIGINS="$AllowedOrigins"

Write-Host "✓ Environment variables set" -ForegroundColor Green
Write-Host "  JWT_SECRET: [set - $($JwtSecret.Length) chars]" -ForegroundColor Gray
Write-Host "  NODE_ENV: production" -ForegroundColor Gray
Write-Host "  ALLOWED_ORIGINS: $AllowedOrigins" -ForegroundColor Gray

# ── STEP 6: Deploy ────────────────────────────────────────────
Write-Host ""
Write-Host "[6/7] Deploying to Railway..." -ForegroundColor Yellow
railway up --detach
if ($LASTEXITCODE -ne 0) { Write-Host "Deployment failed" -ForegroundColor Red; exit 1 }
Write-Host "✓ Deployment initiated" -ForegroundColor Green

# Wait for deployment
Write-Host "      Waiting 30 seconds for deployment to complete..." -ForegroundColor Cyan
Start-Sleep -Seconds 30

# Get the deployment URL
$deployUrl = railway domain 2>$null
if ($deployUrl) {
    $ApiBase = "https://$deployUrl/api"
} else {
    $ApiBase = "https://hope-recovery-backend-production.up.railway.app/api"
}
Write-Host "      API base: $ApiBase" -ForegroundColor Cyan

# ── STEP 7: Apply schema ──────────────────────────────────────
Write-Host ""
Write-Host "[7a/7] Applying database schema..." -ForegroundColor Yellow

if ($SkipSchema) {
    Write-Host "      Skipped (--SkipSchema flag set)" -ForegroundColor Gray
} else {
    try {
        railway run psql `$DATABASE_URL -f schema.sql
        if ($LASTEXITCODE -eq 0) {
            Write-Host "✓ Schema applied" -ForegroundColor Green
        } else {
            Write-Host "  Schema apply failed - you may need to run manually:" -ForegroundColor Yellow
            Write-Host "  railway run psql `$DATABASE_URL -f schema.sql" -ForegroundColor Cyan
        }
    } catch {
        Write-Host "  psql not found locally. Apply schema via Railway console:" -ForegroundColor Yellow
        Write-Host "  1. Go to Railway dashboard → PostgreSQL → Connect" -ForegroundColor Cyan
        Write-Host "  2. Open Query tab" -ForegroundColor Cyan
        Write-Host "  3. Paste contents of schema.sql and run" -ForegroundColor Cyan
    }
}

# ── STEP 7b: Seed curriculum ──────────────────────────────────
Write-Host ""
Write-Host "[7b/7] Seeding 52-lesson curriculum..." -ForegroundColor Yellow

if ($SkipSeed) {
    Write-Host "      Skipped (--SkipSeed flag set)" -ForegroundColor Gray
} else {
    $env:API_BASE = $ApiBase
    $env:ADMIN_USER = "RRNHQ"
    $env:ADMIN_PASS = "ACTS2:38"
    
    node seed-curriculum.js
    if ($LASTEXITCODE -eq 0) {
        Write-Host "✓ Curriculum seeded (52 lessons)" -ForegroundColor Green
    } else {
        Write-Host "  Seed failed - run manually after deployment:" -ForegroundColor Yellow
        Write-Host "  `$env:API_BASE='$ApiBase'; node seed-curriculum.js" -ForegroundColor Cyan
    }
}

# ── HEALTH CHECK ──────────────────────────────────────────────
Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  DEPLOYMENT COMPLETE" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Testing health endpoint..." -ForegroundColor Yellow

try {
    $health = Invoke-RestMethod -Uri "$ApiBase/health" -Method GET -TimeoutSec 15
    Write-Host "✓ Health check PASSED: $($health.status)" -ForegroundColor Green
} catch {
    Write-Host "  Health check failed (server may still be starting)" -ForegroundColor Yellow
    Write-Host "  Test manually: $ApiBase/health" -ForegroundColor Cyan
}

Write-Host ""
Write-Host "API:          $ApiBase" -ForegroundColor White
Write-Host "Login:        POST $ApiBase/auth" -ForegroundColor White
Write-Host "Default creds: RRNHQ / ACTS2:38" -ForegroundColor White
Write-Host ""
Write-Host "IMPORTANT: Change the default password immediately!" -ForegroundColor Red
Write-Host ""
Write-Host "Next step: Update REFINED_Recovery_Network.html with correct API URL" -ForegroundColor Cyan
Write-Host "  Current: https://hope-recovery-backend-production.up.railway.app/api" -ForegroundColor Gray

# Save JWT secret to a local file (gitignored)
$JwtSecret | Out-File -FilePath ".jwt_secret.txt" -NoNewline
Write-Host ""
Write-Host "JWT secret saved to .jwt_secret.txt (keep this safe, do not commit)" -ForegroundColor Yellow
Write-Host ""
Write-Host "Walk it out faithfully. — Refined Recovery Network" -ForegroundColor Cyan
