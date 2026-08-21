#Requires -Version 5.1
<#
.SYNOPSIS
    ABNY / «ابني» — create a test household on a deployed host through the real
    API and print its credentials. PowerShell twin of
    scripts/seed-test-accounts.sh.

.DESCRIPTION
    It creates, over HTTP, exactly what a first-time family creates:

      1. a parent account (registration creates the family and its OWNER)
      2. a child — and attempts a second, which is the paywall boundary
      3. a one-time pairing code for the first child's device

    THERE IS NO "SUPER ADMIN" ACCOUNT TO CREATE, AND THIS WILL NOT INVENT ONE.
    `Role.SUPER_ADMIN` is not a user row: it is whoever holds
    INTERNAL_ADMIN_API_KEY, checked by InternalAdminGuard from an
    `x-internal-admin-key` header. It has no email, no password and no family,
    and the guard deliberately does not write `request.user` — a platform
    operator has no tenant. So the operator "credential" is a key you set on
    the service and type into the dashboard's unlock screen at runtime.

    THERE IS NO SEPARATE "ADMIN" LOGIN EITHER. The admin dashboard signs in
    with POST /auth/login using an ORDINARY PARENT ACCOUNT — the one below. Its
    family screens then show that family and no other.

    AND A CHILD HAS NO CREDENTIALS AT ALL, by product decision: the device is
    paired, and the pairing code printed here is what the child app consumes. A
    child must not be able to authenticate as anything.

    THE SECOND CHILD IS OPTIONAL BECAUSE THE PRODUCT SAYS SO. A fresh family's
    plan allows one child; the second returns 403 PLAN_UPGRADE_REQUIRED. That
    is the paywall working, and it is reported rather than treated as failure.

.PARAMETER BaseUrl
    The deployed host, e.g. https://familyos-staging.up.railway.app

.NOTES
    THE PASSWORD is generated on this machine, or taken from
    $env:ABNY_TEST_PASSWORD. It is never sent anywhere except to the host you
    name, and is written to TEST-ACCOUNTS.txt, which .gitignore excludes. Do
    not paste it into a chat, an issue or a commit — the accounts are
    disposable, the habit is not.

    THIS REGISTERS A REAL ACCOUNT on whatever host you point it at. There is
    no undo.

.EXAMPLE
    .\scripts\seed-test-accounts.ps1 https://familyos-staging.up.railway.app
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)][string]$BaseUrl
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

$BaseUrl = $BaseUrl.TrimEnd('/')
$Api = "$BaseUrl/api/v1"
$OutFile = if ($env:ABNY_TEST_OUT) { $env:ABNY_TEST_OUT } else { 'TEST-ACCOUNTS.txt' }

# A stamp so repeated runs never collide on the unique email constraint, and so
# every account this script has made is identifiable at a glance.
$Stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
$Email = if ($env:ABNY_TEST_EMAIL) { $env:ABNY_TEST_EMAIL } else { "abny.test.$Stamp@example.com" }

<#
    The backend requires 10+ characters with at least one letter and one digit.
    Both are guaranteed by CONSTRUCTION rather than by chance: a generator that
    can emit an invalid password will emit one, on some run, at the worst time.
#>
$Password = $env:ABNY_TEST_PASSWORD
if ([string]::IsNullOrWhiteSpace($Password)) {
    $bytes = New-Object byte[] 16
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $Password = 'Abny' + (($bytes | ForEach-Object { $_.ToString('x2') }) -join '') + '1'
}

function Invoke-Api {
    param([string]$Path, [hashtable]$Body, [string]$Token)
    $headers = @{ 'content-type' = 'application/json' }
    if ($Token) { $headers['authorization'] = "Bearer $Token" }
    try {
        $res = Invoke-RestMethod -Uri "$Api$Path" -Method Post -Headers $headers `
            -Body ($Body | ConvertTo-Json -Depth 6) -TimeoutSec 30 -ErrorAction Stop
        return @{ Ok = $true; Code = 200; Body = $res; Raw = '' }
    } catch {
        $code = 0
        $raw = ''
        $ex = $_.Exception
        if ($ex.PSObject.Properties.Name -contains 'Response' -and $null -ne $ex.Response) {
            try { $code = [int]$ex.Response.StatusCode } catch { $code = 0 }
        }
        if ($_.PSObject.Properties.Name -contains 'ErrorDetails' -and $null -ne $_.ErrorDetails) {
            $raw = [string]$_.ErrorDetails.Message
        }
        if ([string]::IsNullOrEmpty($raw)) { $raw = $ex.Message }
        return @{ Ok = $false; Code = $code; Body = $null; Raw = $raw }
    }
}

function Stop-Seed {
    param([string]$Step, [int]$Code, [string]$Detail)
    Write-Host ''
    Write-Host "BLOCKED at: $Step"
    Write-Host "HTTP $Code"
    Write-Host $Detail
    Write-Host ''
    Write-Host 'Nothing further was created. Fix the above and run again — the email is'
    Write-Host 'timestamped, so a retry never collides with this attempt.'
    exit 1
}

Write-Host '=== ABNY TEST ACCOUNTS ==================================================='
Write-Host "host   $BaseUrl"
Write-Host "email  $Email"
Write-Host '=========================================================================='

# --- 1. the parent, and with it the family ---------------------------------
$r = Invoke-Api '/auth/register' @{
    email = $Email; password = $Password; fullName = 'ABNY Test Parent'
    familyName = 'ABNY Test Family'; acceptedTerms = $true
    timezone = 'Africa/Cairo'; countryCode = 'EG'
}
if (-not $r.Ok) {
    if ($r.Code -eq 429) {
        Stop-Seed 'POST /auth/register' $r.Code 'Rate limited — registration allows 5 per minute per IP. Wait a minute.'
    }
    Stop-Seed 'POST /auth/register' $r.Code $r.Raw
}
Write-Host 'created  parent account'

# --- 2. a session, obtained the way a real client obtains one --------------
# `register` returns the PROFILE, not a session, so the token comes from the
# real login flow — the same path the apps take, not a shortcut only this
# script could use.
$r = Invoke-Api '/auth/login' @{ email = $Email; password = $Password }
if (-not $r.Ok) { Stop-Seed 'POST /auth/login' $r.Code $r.Raw }
$token = $null
if ($r.Body.PSObject.Properties.Name -contains 'tokens') { $token = $r.Body.tokens.accessToken }
if (-not $token -and $r.Body.PSObject.Properties.Name -contains 'accessToken') { $token = $r.Body.accessToken }
if (-not $token) { Stop-Seed 'POST /auth/login' $r.Code 'logged in, but no access token in the response.' }
Write-Host 'created  session'

# --- 3. the children -------------------------------------------------------
$script:FirstChild = $null
$script:SecondChild = $null
$script:PlanNote = ''

function Add-Child {
    param([string]$First, [string]$Dob, [bool]$Required)
    $res = Invoke-Api '/children' @{
        firstName = $First; lastName = 'Test'; dateOfBirth = $Dob; gender = 'unspecified'
    } $token

    if (-not $res.Ok -and $res.Code -eq 403 -and $res.Raw -match 'PLAN_UPGRADE_REQUIRED') {
        if ($Required) {
            Stop-Seed "POST /children ($First)" $res.Code `
                "The plan refused the FIRST child. That is not the paywall working — that is a broken entitlement. $($res.Raw)"
        }
        Write-Host "skipped  child $First — the plan on a new family allows one child (403 PLAN_UPGRADE_REQUIRED)"
        $script:PlanNote = 'the current plan allows ONE child; sibling scenarios need an upgraded plan'
        return
    }
    if (-not $res.Ok) { Stop-Seed "POST /children ($First)" $res.Code $res.Raw }

    $id = $null
    if ($res.Body.PSObject.Properties.Name -contains 'id') { $id = $res.Body.id }
    elseif ($res.Body.PSObject.Properties.Name -contains 'childId') { $id = $res.Body.childId }
    if (-not $id) { Stop-Seed "POST /children ($First)" $res.Code 'created, but no id in the response.' }

    Write-Host "created  child $First ($id)"
    if (-not $script:FirstChild) { $script:FirstChild = $id } else { $script:SecondChild = $id }
}

Add-Child 'Omar'  '2015-04-12' $true
Add-Child 'Salma' '2018-09-30' $false

# --- 4. a pairing code for the child app -----------------------------------
$r = Invoke-Api '/pairing/invite' @{ childId = $script:FirstChild } $token
if (-not $r.Ok) { Stop-Seed 'POST /pairing/invite' $r.Code $r.Raw }
$pairCode = $r.Body.code
$pairTtl = $r.Body.expiresInSeconds
Write-Host 'created  pairing code for Omar'

# --- the credentials -------------------------------------------------------
$lines = @()
$lines += 'ABNY — TEST ACCOUNTS'
$lines += "host    : $BaseUrl"
$lines += "created : $Stamp"
$lines += ''
$lines += 'PARENT / ADMIN DASHBOARD LOGIN  (the dashboard has no separate admin account)'
$lines += "  email    : $Email"
$lines += "  password : $Password"
$lines += '  use for  : the dashboard sign-in page, and the parent mobile app'
$lines += ''
$lines += 'CHILD APP PAIRING  (a child has no email and no password, by design)'
$lines += "  child    : Omar (id $($script:FirstChild))"
$lines += "  code     : $pairCode"
$lines += "  expires  : $pairTtl seconds from creation — regenerate with POST /pairing/invite"
if ($script:SecondChild) {
    $lines += "  sibling  : Salma (id $($script:SecondChild)) — invite separately when you need a second device"
}
if ($script:PlanNote) {
    $lines += ''
    $lines += 'PLAN LIMIT OBSERVED ON THIS HOST'
    $lines += "  $($script:PlanNote)."
    $lines += '  This is the paywall behaving correctly, not a seeding failure.'
}
$lines += ''
$lines += 'PLATFORM OPERATOR ("super admin")'
$lines += '  There is no account. The operator surface is held by whoever knows'
$lines += '  INTERNAL_ADMIN_API_KEY, sent as the x-internal-admin-key header and'
$lines += '  typed into the dashboard''s unlock screen at runtime. Set that variable'
$lines += '  on the backend service; it is never a row in the users table and is'
$lines += '  deliberately not created by this script.'

$lines | ForEach-Object { Write-Host $_ }
$lines | Set-Content -Path $OutFile -Encoding UTF8

Write-Host ''
Write-Host "written to $OutFile — it is git-ignored. Do not paste it into a chat or a commit."
Write-Host 'TEST ACCOUNTS READY'
exit 0
