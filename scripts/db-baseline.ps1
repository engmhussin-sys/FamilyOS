#Requires -Version 5.1
<#
.SYNOPSIS
    ABNY / «ابني» — teach Prisma about a database that already has tables,
    and REFUSE to do it when that would be a lie. PowerShell twin of
    scripts/db-baseline.sh.

.DESCRIPTION
    WHAT HAPPENED. 2026-08-21 08:22, Railway deploy log, on a container that
    had just been built and pushed perfectly:

      29 migrations found in prisma/migrations
      Error: P3005
      The database schema is not empty.
      Stopping Container

    `preDeployCommand` failed, so Railway ABORTED THE PROMOTION and left the
    previous deployment serving. Two images were built that day; neither ever
    ran. The build tab stayed green throughout.

    P3005 fires on exactly one condition: the schema has tables AND
    `_prisma_migrations` is missing or empty. That means no migration has ever
    been applied to this database through Prisma Migrate — its tables came
    from `prisma db push`, or from SQL run by hand. Prisma cannot know which of
    the 29 migrations those tables already represent, so it refuses rather than
    guess. That refusal is correct.

    WHAT BASELINING IS. Writing rows into `_prisma_migrations` that say "this
    migration is already applied" WITHOUT running its SQL. It is a CLAIM ABOUT
    THE DATABASE, and a false claim is the most expensive mistake available
    here: baseline a database missing migration 0030's columns and
    `migrate deploy` skips 0030 forever, leaving new code on an old schema —
    200 on every route that happens not to touch the new column, 500 on the
    first one that does, in production, later.

    SO IT MEASURES BEFORE IT CLAIMS. `prisma migrate diff` compares the LIVE
    database against schema.prisma and emits the SQL needed to close the gap.

      no gap   baselining is TRUE. It proceeds: one `migrate resolve --applied`
               per migration directory in this repository.
      any gap  REFUSED. The drift is printed in full and nothing is written.

    THE TWO SIGNALS MUST AGREE. `--exit-code` and the emitted script are read
    INDEPENDENTLY; disagreement is refused rather than resolved in favour of
    either. Trusting one channel is one Prisma release away from a silent
    false green.

    READ-ONLY UNTIL IT IS NOT. -Apply is required to write even the ledger
    rows; without it this is a pure diagnosis that prints the commands it
    would have run.

.PARAMETER Apply
    Write the ledger rows — if and only if there is no drift.

.EXAMPLE
    $env:DATABASE_URL = '<public connection string from Railway>'
    .\scripts\db-baseline.ps1                 # diagnose only, writes nothing
    .\scripts\db-baseline.ps1 -Apply          # baseline, if and only if clean

.NOTES
    DATABASE_URL must be REACHABLE FROM HERE. Railway's
    `postgres.railway.internal` host only resolves inside Railway — use the
    PUBLIC connection string from the Postgres service's Connect tab.

    THE URL IS NEVER PRINTED. It carries a password. Only host and database
    are echoed.
#>
[CmdletBinding()]
param(
    [switch]$Apply
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$BackendDir = if ($env:DB_BASELINE_BACKEND_DIR) { $env:DB_BASELINE_BACKEND_DIR } else { Join-Path $RepoRoot 'apps\backend' }

if (-not (Test-Path (Join-Path $BackendDir 'prisma\migrations'))) {
    Write-Host 'BLOCKED: cannot find apps\backend\prisma\migrations. Run this from inside the repository.'
    exit 1
}

if ([string]::IsNullOrWhiteSpace($env:DATABASE_URL)) {
    Write-Host @'
BLOCKED: DATABASE_URL is not set.

Set it to the database you intend to baseline, using the PUBLIC connection
string from Railway (Postgres service -> Connect). The internal host
`postgres.railway.internal` does not resolve outside Railway.

  $env:DATABASE_URL = 'postgresql://...@...proxy.rlwy.net:PORT/railway'
'@
    exit 1
}

<#
    Overridable so the decision logic can be exercised without a live database
    and without Prisma's migration engine. Defaults to the real thing; a test
    must opt in, never the other way round.
#>
function Invoke-Prisma {
    param([string[]]$PrismaArgs)
    if ($env:PRISMA_BIN) {
        $output = & $env:PRISMA_BIN @PrismaArgs 2>&1 | Out-String
    } else {
        $output = & npx prisma @PrismaArgs 2>&1 | Out-String
    }
    return @{ Output = $output; Code = $LASTEXITCODE }
}

function Hide-Credentials {
    param([string]$Url)
    return [regex]::Replace($Url, '^([a-z+]+)://[^@]*@', '$1://<credentials-hidden>@')
}

Write-Host '=== ABNY DB BASELINE ====================================================='
Write-Host "backend  $BackendDir"
Write-Host "target   $(Hide-Credentials $env:DATABASE_URL)"
if ($Apply) {
    Write-Host 'mode     APPLY — will write _prisma_migrations rows if there is no drift'
} else {
    Write-Host 'mode     DIAGNOSE ONLY — writes nothing'
}
Write-Host '=========================================================================='

$migrations = @(Get-ChildItem -Path (Join-Path $BackendDir 'prisma\migrations') -Directory |
    Select-Object -ExpandProperty Name | Sort-Object)

if ($migrations.Count -eq 0) {
    Write-Host 'BLOCKED: no migration directories found. Refusing to baseline nothing.'
    exit 1
}
Write-Host "migrations in this branch : $($migrations.Count)  (newest: $($migrations[-1]))"

# --- the measurement -------------------------------------------------------
Push-Location $BackendDir
try {
    $diff = Invoke-Prisma @(
        'migrate', 'diff',
        '--from-url', $env:DATABASE_URL,
        '--to-schema-datamodel', 'prisma/schema.prisma',
        '--script', '--exit-code'
    )
} finally {
    Pop-Location
}

$diffExit = $diff.Code
<#
    Prisma prints a comment line for an empty diff. Rather than matching that
    exact sentence — a string in someone else's release notes — the emitted
    script is judged by whether it holds any line that is neither blank nor a
    comment. That survives a reworded message.
#>
$statements = @($diff.Output -split "`r?`n" | Where-Object { $_ -notmatch '^\s*(--.*)?$' }).Count

Write-Host "diff exit code            : $diffExit   (0 = no drift, 2 = drift)"
Write-Host "non-comment SQL lines     : $statements"

if ($diffExit -ne 0 -and $diffExit -ne 2) {
    Write-Host ''
    Write-Host 'BLOCKED: prisma migrate diff failed to run. Its output:'
    Write-Host $diff.Output
    Write-Host ''
    Write-Host 'Nothing was written. Fix the connection or the toolchain and run again.'
    exit 1
}

$codeSaysClean = ($diffExit -eq 0)
$scriptSaysClean = ($statements -eq 0)

if ($codeSaysClean -ne $scriptSaysClean) {
    $byCode = if ($codeSaysClean) { 'no drift' } else { 'drift' }
    $byScript = if ($scriptSaysClean) { 'no drift' } else { 'drift' }
    Write-Host ''
    Write-Host "BLOCKED: the two signals disagree — exit code says $byCode, the emitted script says $byScript."
    Write-Host 'Refusing to baseline on an ambiguous measurement. The emitted script:'
    Write-Host '--------------------------------------------------------------------'
    Write-Host $diff.Output
    exit 1
}

# --- drift: refuse, and show the operator exactly what it is ---------------
if (-not $codeSaysClean) {
    Write-Host @'

BLOCKED — THE DATABASE DOES NOT MATCH THIS BRANCH'S SCHEMA.

Baselining now would record migrations as applied that are NOT in this
database. `migrate deploy` would then skip them permanently, and the
application would run new code on an old schema — a fault that shows up as a
200 on every route that happens not to touch the missing column, and as a
500 on the first one that does.

The SQL below is what the live database is MISSING relative to
prisma/schema.prisma. Nothing has been written.

--------------------------- DRIFT (not applied) ---------------------------
'@
    Write-Host $diff.Output
    Write-Host @'
---------------------------------------------------------------------------

TWO HONEST WAYS FORWARD, and which one is right depends on ONE question:
does this database hold real data you cannot lose?

  NO  (staging, a scratch environment)
      Drop and recreate the schema, then let `migrate deploy` build it from
      empty — the path that is proven: 29 migrations, 101 tables, and a
      ledger Prisma wrote itself, so P3005 can never recur here.

  YES (production, or anything with real households in it)
      Do NOT reset, and do NOT baseline. Send this drift for review first.
      The subset of migrations already represented in the schema has to be
      established migration by migration; only that subset may be resolved
      as applied, and the rest must actually run.

'@
    exit 1
}

# --- no drift: baselining is true ------------------------------------------
Write-Host ''
Write-Host "NO DRIFT. The live database already matches prisma/schema.prisma, so"
Write-Host "recording all $($migrations.Count) migrations as applied is a TRUE statement"
Write-Host 'about it, not a guess.'
Write-Host ''

if (-not $Apply) {
    Write-Host 'DIAGNOSE ONLY — nothing was written. These are the commands -Apply would run:'
    foreach ($name in $migrations) {
        Write-Host "  npx prisma migrate resolve --applied $name"
    }
    Write-Host ''
    Write-Host 'Re-run with -Apply to write them.'
    Write-Host 'SAFE TO BASELINE'
    exit 0
}

$failed = 0
Push-Location $BackendDir
try {
    foreach ($name in $migrations) {
        $res = Invoke-Prisma @('migrate', 'resolve', '--applied', $name)
        if ($res.Code -eq 0) {
            Write-Host "  applied-marker written : $name"
        } else {
            Write-Host "  FAILED                 : $name"
            $failed++
        }
    }
} finally {
    Pop-Location
}

Write-Host '=========================================================================='
if ($failed -gt 0) {
    Write-Host "$failed of $($migrations.Count) markers could not be written. The ledger is INCOMPLETE —"
    Write-Host 'do not deploy until every migration above is accounted for.'
    exit 1
}

Write-Host "All $($migrations.Count) migrations are now recorded as applied."
Write-Host ''
Write-Host 'Redeploy. `prisma migrate deploy` will find a complete ledger, apply'
Write-Host 'nothing, and the container will start. Then confirm with the deploy doctor —'
Write-Host 'its schema-version row reads the same ledger back out of the running host:'
Write-Host ''
Write-Host '  .\scripts\deploy-doctor.ps1 https://<host> -Key $env:INTERNAL_ADMIN_API_KEY'
Write-Host 'BASELINE COMPLETE'
exit 0
