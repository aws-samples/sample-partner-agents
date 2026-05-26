# Partner Central MCP — Quick Setup (Windows)
# Installs prerequisites, checks Partner Central access, and verifies connectivity.
# Usage: .\setup.ps1 [-Profile "my-profile"] [-Sandbox]

param(
    [string]$Profile = "",
    [switch]$Sandbox
)

$ErrorActionPreference = "Stop"
$Endpoint = "https://partnercentral-agents-mcp.us-east-1.api.aws/mcp"
$Service = "partnercentral-agents-mcp"
$Region = "us-east-1"
$Catalog = if ($Sandbox) { "Sandbox" } else { "AWS" }

# If no profile specified, list available profiles and let user choose
if (-not $Profile) {
    $profiles = @(& aws configure list-profiles 2>$null | Where-Object { $_ -ne "" })
    if ($profiles.Count -eq 0) {
        Write-Host "❌ No AWS CLI profiles found. Run: aws configure" -ForegroundColor Red
        exit 1
    } elseif ($profiles.Count -eq 1) {
        $Profile = $profiles[0]
        Write-Host "Using the only available AWS profile: $Profile"
    } else {
        Write-Host "Available AWS CLI profiles:"
        Write-Host ""
        for ($i = 0; $i -lt $profiles.Count; $i++) {
            Write-Host "  $($i+1)) $($profiles[$i])"
        }
        Write-Host ""
        $choice = Read-Host "Select profile [1-$($profiles.Count)]"
        $idx = [int]$choice - 1
        if ($idx -ge 0 -and $idx -lt $profiles.Count) {
            $Profile = $profiles[$idx]
        } else {
            Write-Host "❌ Invalid selection." -ForegroundColor Red
            exit 1
        }
    }
}

Write-Host ""
Write-Host "=== Partner Central MCP Setup ===" -ForegroundColor Cyan
Write-Host "AWS Profile: $Profile"
Write-Host "Sandbox:     $Sandbox"
Write-Host ""

# 1. Check Python
Write-Host "[1/6] Checking Python..."
try {
    $pyVersion = & python --version 2>&1 | Select-String -Pattern "(\d+\.\d+\.\d+)" | ForEach-Object { $_.Matches[0].Value }
    $parts = $pyVersion.Split(".")
    if ([int]$parts[0] -ge 3 -and [int]$parts[1] -ge 10) {
        Write-Host "  ✅ Python $pyVersion" -ForegroundColor Green
    } else {
        Write-Host "  ❌ Python $pyVersion found — need 3.10+. Install from https://python.org" -ForegroundColor Red
        exit 1
    }
} catch {
    Write-Host "  ❌ Python not found. Install Python 3.10+ from https://python.org" -ForegroundColor Red
    exit 1
}

# 2. Check AWS CLI
Write-Host "[2/6] Checking AWS CLI..."
try {
    $awsVersion = & aws --version 2>&1 | Select-Object -First 1
    Write-Host "  ✅ $awsVersion" -ForegroundColor Green
} catch {
    Write-Host "  ❌ AWS CLI not found. Install from: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html" -ForegroundColor Red
    exit 1
}

# 3. Check/install uv
Write-Host "[3/6] Checking uv..."
try {
    $uvVersion = & uv --version 2>&1 | Select-Object -First 1
    Write-Host "  ✅ uv $uvVersion" -ForegroundColor Green
} catch {
    Write-Host "  Installing uv..."
    irm https://astral.sh/uv/install.ps1 | iex
    Write-Host "  ✅ uv installed. Restart your terminal, then re-run this script." -ForegroundColor Yellow
    exit 0
}

# 4. Check AWS credentials
Write-Host "[4/6] Checking AWS credentials (profile: $Profile)..."
try {
    $env:AWS_PROFILE = $Profile
    $identity = & aws sts get-caller-identity --output text --query "Arn" 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  ✅ Authenticated as: $identity" -ForegroundColor Green
    } else {
        throw "Auth failed"
    }
} catch {
    Write-Host "  ❌ AWS credentials not valid for profile '$Profile'." -ForegroundColor Red
    Write-Host "     Run: aws configure --profile $Profile"
    Write-Host "     Or:  aws sso login --profile $Profile"
    exit 1
}

# 5. Check Partner Central access
Write-Host "[5/6] Checking Partner Central access ($Catalog catalog)..."
try {
    $env:AWS_PROFILE = $Profile
    $pcResult = & aws partnercentral-selling list-opportunities --catalog $Catalog --region $Region --max-results 1 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  ✅ Partner Central access confirmed ($Catalog catalog)" -ForegroundColor Green
    } else {
        $errorText = $pcResult | Out-String
        if ($errorText -match "AccessDeniedException") {
            Write-Host "  ⚠️  Access denied to Partner Central ($Catalog catalog)." -ForegroundColor Yellow
            Write-Host ""
            Write-Host "     Your IAM identity needs Partner Central permissions."
            Write-Host "     Quickest fix: attach the AWSMcpServiceActionsFullAccess managed policy."
            Write-Host ""
            if ($Sandbox) {
                Write-Host "     For Sandbox access, your IAM role also needs the Sandbox-scoped policy."
                Write-Host "     See: https://docs.aws.amazon.com/partner-central/latest/APIReference/testing-sandbox-account.html"
                Write-Host ""
                Write-Host "     If your account is not yet registered as a partner in the Sandbox:"
                Write-Host "     1. Attach the Sandbox IAM policy (includes partnercentral:CreatePartner)"
                Write-Host "     2. Call CreatePartner with Catalog=Sandbox to register"
                Write-Host "     3. Then call StartProfileUpdateTask to complete setup"
            }
            Write-Host ""
            Write-Host "     After fixing permissions, re-run this script."
            exit 1
        } else {
            Write-Host "  ⚠️  Unexpected response from Partner Central. May still work in Quick." -ForegroundColor Yellow
        }
    }
} catch {
    Write-Host "  ⚠️  Could not verify Partner Central access. May still work in Quick." -ForegroundColor Yellow
}

# 6. Check MCP proxy
Write-Host "[6/6] Testing MCP proxy availability..."
try {
    $help = & uvx mcp-proxy-for-aws@latest --help 2>&1
    if ($help -match "mcp-proxy") {
        Write-Host "  ✅ Proxy package available" -ForegroundColor Green
    } else {
        Write-Host "  ⚠️  Proxy responded unexpectedly — may still work in Quick." -ForegroundColor Yellow
    }
} catch {
    Write-Host "  ⚠️  Could not verify proxy — check uv installation." -ForegroundColor Yellow
}

# Print Quick configuration
Write-Host ""
Write-Host "=== Amazon Quick Configuration ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Go to: Settings → Capabilities → MCP → + Add MCP → Local"
Write-Host ""
Write-Host "  Name:        Partner Central"
Write-Host "  Command:     uvx"
Write-Host "  Arguments:   mcp-proxy-for-aws@latest $Endpoint --service $Service"
Write-Host "  Timeout:     300"
Write-Host ""
Write-Host "  Environment variables:"
Write-Host "    AWS_PROFILE = $Profile"
Write-Host "    AWS_REGION  = $Region"
Write-Host ""
Write-Host "=== Setup Complete ===" -ForegroundColor Green
Write-Host ""
Write-Host 'After configuring in Quick, test with: "List my open opportunities"'
if ($Sandbox) {
    Write-Host "For Sandbox, include 'use the Sandbox catalog' in your prompts."
}
