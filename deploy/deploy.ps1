<#
    Deploys the committed HEAD of this repository to the staging server and
    brings the stack up with Docker Compose.

    Usage:
        ./deploy/deploy.ps1 -ServerHost 192.168.1.50 -User badar

    What it does, and why it is shaped this way:

    - Ships `git archive HEAD`, not the working copy. Only committed, tracked
      files travel, which means no node_modules, no apps/mobile/android, no
      .env and no signing keystore can reach the server by accident. The
      trade-off is that uncommitted work is NOT deployed; the script says so
      before doing anything when the tree is dirty.

    - Builds the images on the server. No registry to run, nothing to
      authenticate against, and the server needs outbound access to npm and
      Docker Hub only.

    - Never transfers secrets. .env.production is created once on the server
      and left alone; because it is untracked it is not in the archive, so
      re-deploying cannot overwrite it. The script stops with instructions if
      it is missing rather than starting the stack with defaults.

    - Migrations run as a compose service the API waits on, so they cannot be
      forgotten. See deploy/compose.prod.yml.
#>

[CmdletBinding()]
param(
    # The staging server's address. Positional so the common case is short.
    [Parameter(Mandatory = $true, Position = 0)]
    [string] $ServerHost,

    # The SSH account to deploy as. It must be able to run docker.
    [Parameter(Mandatory = $true)]
    [string] $User,

    [string] $KeyFile = (Join-Path $HOME '.ssh\psx_trader_staging'),

    [string] $RemotePath = '/srv/psx-trader',

    # Override to deploy a tag or an older commit.
    [string] $Ref = 'HEAD',

    # Skip the "your tree is dirty" prompt, for scripted use.
    [switch] $Force
)

$ErrorActionPreference = 'Stop'

$repo = Split-Path $PSScriptRoot -Parent
$target = "$User@$ServerHost"
$sshArgs = @('-i', $KeyFile, '-o', 'StrictHostKeyChecking=accept-new')

function Invoke-Remote {
    param([string] $Command)
    & ssh @sshArgs $target $Command
    if ($LASTEXITCODE -ne 0) { throw "Remote command failed ($LASTEXITCODE): $Command" }
}

if (-not (Test-Path $KeyFile)) {
    throw "No SSH key at $KeyFile. Generate one, or pass -KeyFile."
}

# --- Warn about anything not committed ------------------------------------

Push-Location $repo
try {
    $dirty = & git status --porcelain
    $commit = (& git rev-parse --short $Ref).Trim()
    $describe = (& git log -1 --format='%s' $Ref).Trim()

    if ($dirty -and -not $Force) {
        Write-Host 'Uncommitted changes will NOT be deployed:' -ForegroundColor Yellow
        $dirty | ForEach-Object { Write-Host "  $_" }
        Write-Host ''
        Write-Host "Deploying $Ref ($commit) - $describe"
        $answer = Read-Host 'Continue? [y/N]'
        if ($answer -ne 'y') { Write-Host 'Aborted.'; return }
    } else {
        Write-Host "Deploying $Ref ($commit) - $describe"
    }

    # --- Package the commit -----------------------------------------------

    # A file rather than a pipe: a PowerShell pipeline is a stream of objects
    # that get encoded as text, which corrupts a tar on its way to ssh.
    $tar = Join-Path ([System.IO.Path]::GetTempPath()) "psx-trader-$commit.tar"
    & git archive --format=tar --output=$tar $Ref
    if ($LASTEXITCODE -ne 0) { throw 'git archive failed.' }
    $tarSize = [Math]::Round((Get-Item $tar).Length / 1MB, 1)
    Write-Host "Archive: $tarSize MB"
} finally {
    Pop-Location
}

try {
    # --- Transfer ---------------------------------------------------------

    Invoke-Remote "mkdir -p '$RemotePath'"
    & scp @sshArgs $tar "${target}:$RemotePath/release.tar"
    if ($LASTEXITCODE -ne 0) { throw 'scp failed.' }

    # Tracked files are replaced; untracked ones - .env.production above all -
    # are left where they are.
    Invoke-Remote "tar -xf '$RemotePath/release.tar' -C '$RemotePath' && rm '$RemotePath/release.tar'"

    # --- Refuse to run without configuration ------------------------------

    $envPath = "$RemotePath/deploy/.env.production"
    & ssh @sshArgs $target "test -f '$envPath'"
    if ($LASTEXITCODE -ne 0) {
        Write-Host ''
        Write-Host 'The server has no deploy/.env.production yet.' -ForegroundColor Yellow
        Write-Host 'Create it there, then run this script again:'
        Write-Host ''
        Write-Host "  ssh -i $KeyFile $target"
        Write-Host "  cd $RemotePath/deploy"
        Write-Host '  cp env.production.example .env.production'
        Write-Host '  chmod 600 .env.production'
        Write-Host '  openssl rand -hex 32   # once for each JWT secret'
        Write-Host '  nano .env.production'
        Write-Host ''
        Write-Host 'Nothing was started. The code is already in place, so the next'
        Write-Host 'run will only build and start.'
        return
    }

    # --- Build and start --------------------------------------------------

    $compose = "cd '$RemotePath/deploy' && docker compose -f compose.prod.yml --env-file .env.production"

    Write-Host ''
    Write-Host 'Building images on the server...'
    Invoke-Remote "$compose build"

    Write-Host 'Starting (migrations run first and the API waits for them)...'
    Invoke-Remote "$compose up -d --remove-orphans"

    Write-Host ''
    Invoke-Remote "$compose ps"

    # --- Prove it answers -------------------------------------------------

    Write-Host ''
    Write-Host 'Checking health from the server...'
    Invoke-Remote "curl -fsS --max-time 10 --retry 10 --retry-delay 3 --retry-all-errors http://127.0.0.1:4000/health/ready > /dev/null && echo '  api  : ready'"
    Invoke-Remote "curl -fsS --max-time 20 --retry 10 --retry-delay 3 --retry-all-errors -o /dev/null http://127.0.0.1:3000/ && echo '  web  : serving'"

    Write-Host ''
    Write-Host "Dashboard : http://${ServerHost}:3000"
    Write-Host "API       : http://${ServerHost}:4000"
    Write-Host ''
    Write-Host 'For the phone app to use this server, set expo.extra.apiBaseUrl in'
    Write-Host "apps/mobile/app.json to http://${ServerHost}:4000 and rebuild the APK."
} finally {
    if (Test-Path $tar) { Remove-Item $tar -Force }
}
