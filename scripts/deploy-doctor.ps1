#Requires -Version 5.1
<#
.SYNOPSIS
    ABNY / «ابني» — WHICH BUILD IS SERVING THIS URL, AND ON WHICH SCHEMA?
    Read-only. The PowerShell twin of scripts/deploy-doctor.sh, row for row.

.DESCRIPTION
    THE QUESTION IT ANSWERS. A green "Deployed" badge means an image was
    pushed. It does not mean the container booted, it does not mean this
    branch's code is the code answering, and it does not mean
    `prisma migrate deploy` ran. On 2026-08-21 this project had all three
    doubts at once: a first successful image build, and a staging host that
    answered GET /health/ready with {"status":"ok","database":true,
    "redis":true} while still serving a build from before the operator surface
    was closed. /health/ready asks whether Postgres answers SELECT 1 — a schema
    thirty migrations behind answers that exactly as cheerfully as today's.

      PASS     met AND MEASURED on the live host.
      WARN     a real gap that does not make the deploy wrong, or a fact this
               run could not measure and refuses to claim.
      BLOCKED  what is deployed is not what you think is deployed.

    THE ONE CHECK THAT CANNOT BE FAKED. GET /api/v1/system/diagnostics is
    behind InternalAdminGuard in this codebase and was ANONYMOUS before it. So
    an unauthenticated call is a build fingerprint needing no key and no access
    to the platform console:

      401      a build WITH the guard. Current code.
      200      a build WITHOUT it. Old code — and the operator console is open
               to the internet right now.
      500/503  also a build without it: the route answered, so its handler
               chose the status. A guarded route never reaches its handler.
      404      wrong host, wrong prefix, or a build older than the route.

    WHERE THE EXPECTED VALUES COME FROM. The repository, at run time: the
    newest directory under apps\backend\prisma\migrations, and
    `git rev-parse HEAD`. No number in this file is typed from memory.

    NO FALSE PASSES. A check that "passes" because the host could not be
    resolved, or because a variable was unset, is worse than no check. Where a
    fact cannot be measured without the operator key, the row says NOT VERIFIED
    and grades WARN. It never says PASS.

    THE TERMINAL LINE. If any check is BLOCKED the LAST line printed is the
    unindented token meaning "do not ship", and the exit code is 1.

.PARAMETER BaseUrl
    The deployed host, e.g. https://familyos-staging.up.railway.app

.PARAMETER Key
    The operator key (INTERNAL_ADMIN_API_KEY). NEVER printed, never logged,
    never written to a file. Prefer passing it from an environment variable so
    it does not enter your PowerShell history:

        .\scripts\deploy-doctor.ps1 https://host -Key $env:INTERNAL_ADMIN_API_KEY

.EXAMPLE
    .\scripts\deploy-doctor.ps1 https://familyos-staging.up.railway.app
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)][string]$BaseUrl,
    [string]$Key = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$BaseUrl = $BaseUrl.TrimEnd('/')
$RepoRoot = Split-Path -Parent $PSScriptRoot
$script:Blocked = 0
$script:Warned = 0

function Write-Row {
    param([string]$Grade, [string]$Id, [string]$Detail)
    '{0,-8} {1,-34} {2}' -f $Grade, $Id, $Detail | Write-Host
}
function Add-Pass  { param([string]$Id, [string]$Detail) Write-Row 'PASS'    $Id $Detail }
function Add-Warn  { param([string]$Id, [string]$Detail) Write-Row 'WARN'    $Id $Detail; $script:Warned++ }
function Add-Block { param([string]$Id, [string]$Detail) Write-Row 'BLOCKED' $Id $Detail; $script:Blocked++ }

<#
    ONE request, returning BOTH status and body. Two requests could land on two
    replicas and pair a status with a body that never belonged to it.

    -SkipHttpErrorCheck exists only in PowerShell 7, and every status this
    doctor reads as EVIDENCE is a non-2xx one, so the 4xx/5xx path is the main
    path here, not the error path. It is handled through the exception on 5.1
    and 7 alike rather than branching on $PSVersionTable — a version branch is
    one more thing that can be wrong on the one machine that matters.

    A status of 0 means the request never reached a server. It is returned as 0
    rather than defaulted to anything plausible: "could not reach it" must
    never be indistinguishable from a real status.
#>
function Invoke-Probe {
    param([string]$Path, [hashtable]$Headers = @{})
    $uri = "$BaseUrl$Path"
    try {
        $resp = Invoke-WebRequest -Uri $uri -Headers $Headers -UseBasicParsing -TimeoutSec 20 -ErrorAction Stop
        return @{ Code = [int]$resp.StatusCode; Body = [string]$resp.Content }
    } catch {
        $ex = $_.Exception
        $code = 0
        $body = ''
        if ($ex.PSObject.Properties.Name -contains 'Response' -and $null -ne $ex.Response) {
            try { $code = [int]$ex.Response.StatusCode } catch { $code = 0 }
            try {
                $stream = $ex.Response.GetResponseStream()
                if ($null -ne $stream) {
                    $reader = New-Object System.IO.StreamReader($stream)
                    $body = $reader.ReadToEnd()
                    $reader.Dispose()
                }
            } catch { $body = '' }
            # PowerShell 7 exposes the already-read body here instead.
            if ([string]::IsNullOrEmpty($body) -and $_.PSObject.Properties.Name -contains 'ErrorDetails' -and $null -ne $_.ErrorDetails) {
                $body = [string]$_.ErrorDetails.Message
            }
        }
        return @{ Code = $code; Body = $body }
    }
}

function Get-Field {
    param([string]$Body, [string]$Path)
    if ([string]::IsNullOrWhiteSpace($Body)) { return $null }
    try {
        $obj = $Body | ConvertFrom-Json
        foreach ($segment in $Path.Split('.')) {
            if ($null -eq $obj) { return $null }
            if (-not ($obj.PSObject.Properties.Name -contains $segment)) { return $null }
            $obj = $obj.$segment
        }
        return $obj
    } catch { return $null }
}

Write-Host '=== ABNY DEPLOY DOCTOR ==================================================='
Write-Host "host   $BaseUrl"
Write-Host "repo   $RepoRoot"
if ([string]::IsNullOrEmpty($Key)) {
    Write-Host 'key    not supplied — build identity will be NOT VERIFIED'
} else {
    Write-Host 'key    supplied (never printed)'
}
Write-Host '=========================================================================='

# --- 1. the process ---------------------------------------------------------
$live = Invoke-Probe '/health/live'
switch ($live.Code) {
    200     { Add-Pass  'liveness' 'the process is up and answering' }
    0       { Add-Block 'liveness' "could not reach $BaseUrl at all — check the host name, and that the service is not asleep" }
    default { Add-Block 'liveness' "GET /health/live returned $($live.Code), not 200 — the container is not serving" }
}

# --- 2. its two hard dependencies -------------------------------------------
$ready = Invoke-Probe '/health/ready'
$db = Get-Field $ready.Body 'database'
$rd = Get-Field $ready.Body 'redis'
if ($ready.Code -eq 200) {
    Add-Pass 'readiness' "Postgres and Redis both reachable (database=$db redis=$rd)"
} elseif ($ready.Code -eq 503) {
    Add-Block 'readiness' "degraded: database=$db redis=$rd — a false value names the dependency to fix"
} else {
    Add-Block 'readiness' "GET /health/ready returned $($ready.Code) — expected 200 or 503"
}

# --- 3. WHICH BUILD (needs no key) ------------------------------------------
$anon = Invoke-Probe '/api/v1/system/diagnostics'
switch ($anon.Code) {
    401 { Add-Pass  'build-identity' 'the operator surface is CLOSED — this host is running current code' }
    200 { Add-Block 'build-identity' 'OLD BUILD, AND EXPOSED: /api/v1/system/diagnostics answered an anonymous caller with the build, the environment and every feature flag. Redeploy this service from the current branch.' }
    500 { Add-Block 'build-identity' 'OLD BUILD: the route answered (500) instead of refusing. A guarded route never reaches its handler, so this host predates the guard. Redeploy this service from the current branch.' }
    503 { Add-Block 'build-identity' 'OLD BUILD: the route answered (503) instead of refusing. A guarded route never reaches its handler, so this host predates the guard. Redeploy this service from the current branch.' }
    404 { Add-Block 'build-identity' 'no /api/v1/system/diagnostics here — wrong host, wrong global prefix, or a build older than the route. Confirm the service and its branch.' }
    0   { Add-Block 'build-identity' 'unreachable — see the liveness row above' }
    default { Add-Warn 'build-identity' "unexpected status $($anon.Code) — cannot classify this build; read the body by hand" }
}

# --- 4. WHAT it is, and WHICH SCHEMA (needs the key) ------------------------
$migrationsDir = Join-Path $RepoRoot 'apps\backend\prisma\migrations'
$onDisk = @()
if (Test-Path $migrationsDir) {
    $onDisk = @(Get-ChildItem -Path $migrationsDir -Directory | Select-Object -ExpandProperty Name | Sort-Object)
}
$expectedMigration = if ($onDisk.Count -gt 0) { $onDisk[-1] } else { '' }
$expectedCount = $onDisk.Count
$expectedSha = ''
try { $expectedSha = (git -C $RepoRoot rev-parse HEAD 2>$null) } catch { $expectedSha = '' }

if ([string]::IsNullOrEmpty($Key)) {
    Add-Warn 'build-commit'   'NOT VERIFIED — pass -Key to read the deployed commit'
    Add-Warn 'schema-version' 'NOT VERIFIED — pass -Key to read the applied migrations'
} else {
    $auth = Invoke-Probe '/api/v1/system/diagnostics' @{ 'x-internal-admin-key' = $Key }
    if ($auth.Code -eq 401) {
        Add-Block 'operator-key' 'the key was refused. Either it is wrong, or INTERNAL_ADMIN_API_KEY is unset on this service — in which case the guard is failing closed and NO operator can read diagnostics.'
    } elseif ($auth.Code -ne 200) {
        Add-Block 'operator-key' "diagnostics returned $($auth.Code) with a key — expected 200"
    } else {
        $commit      = Get-Field $auth.Body 'commit'
        $environment = Get-Field $auth.Body 'environment'
        $available   = Get-Field $auth.Body 'schema.available'
        $applied     = Get-Field $auth.Body 'schema.appliedCount'
        $latest      = Get-Field $auth.Body 'schema.latestName'
        $broken      = Get-Field $auth.Body 'schema.unfinishedCount'

        Add-Pass 'environment' "the deployed process calls itself '$environment'"

        if ([string]::IsNullOrEmpty([string]$commit)) {
            Add-Warn 'build-commit' 'the deployed build reports no commit — set GIT_COMMIT_SHA as a build arg so a deploy can be traced to a commit'
        } else {
            # Shortened ONCE, before either branch, so the PASS and the WARN
            # cannot disagree about how a sha is printed.
            $short = [string]$commit
            if ($short.Length -gt 12) { $short = $short.Substring(0, 12) }
            $localShort = [string]$expectedSha
            if ($localShort.Length -gt 12) { $localShort = $localShort.Substring(0, 12) }

            if ([string]$commit -eq [string]$expectedSha) {
                Add-Pass 'build-commit' "deployed commit is this working tree's HEAD ($short)"
            } else {
                Add-Warn 'build-commit' "deployed $short, local HEAD $localShort — expected if you have committed since deploying; BLOCKED if you have not"
            }
        }

        if ($null -eq $available) {
            Add-Warn 'schema-version' "this build's diagnostics has no 'schema' field — it predates MigrationStatusService. Redeploy to measure the applied migrations."
        } elseif (-not $available) {
            Add-Block 'schema-version' "the deployed database has no readable _prisma_migrations table. 'prisma migrate deploy' has never run against it — the preDeployCommand is not doing what railway.json says."
        } elseif ([int]$broken -ne 0) {
            $names = (Get-Field $auth.Body 'schema.unfinishedNames') -join ', '
            Add-Block 'schema-version' "$broken migration(s) started and never finished, or were rolled back. The schema is HALF-migrated: $names"
        } elseif ($latest -eq $expectedMigration -and [int]$applied -eq $expectedCount) {
            Add-Pass 'schema-version' "$applied migrations applied, latest $latest — matches this repository exactly"
        } else {
            Add-Block 'schema-version' "deployed schema is at $applied/$expectedCount (latest '$latest', repository has '$expectedMigration'). The container is running new code on an old schema."
        }
    }
}

Write-Host '=========================================================================='
if ($script:Blocked -gt 0) {
    Write-Host "$($script:Blocked) blocked, $($script:Warned) warned."
    Write-Host 'DO NOT SHIP'
    exit 1
}
Write-Host "0 blocked, $($script:Warned) warned."
Write-Host 'DEPLOY VERIFIED'
exit 0
