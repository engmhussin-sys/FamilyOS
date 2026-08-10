# Ebni - Full verification script (runs remaining phases 3-5 in one execution)
# Usage: open PowerShell (not CMD), paste this whole script, press Enter.

$ErrorActionPreference = "Continue"
$baseUrl = "https://familyos-production-74ca.up.railway.app/api/v1"
$results = @()

function Test-Step {
    param($Name, $ScriptBlock)
    Write-Host "`n=== $Name ===" -ForegroundColor Cyan
    try {
        $result = & $ScriptBlock
        Write-Host "PASS" -ForegroundColor Green
        $script:results += [PSCustomObject]@{ Step = $Name; Status = "PASS"; Detail = ($result | ConvertTo-Json -Compress -Depth 5) }
        return $result
    } catch {
        Write-Host "FAIL: $($_.Exception.Message)" -ForegroundColor Red
        if ($_.ErrorDetails.Message) { Write-Host $_.ErrorDetails.Message -ForegroundColor Red }
        $script:results += [PSCustomObject]@{ Step = $Name; Status = "FAIL"; Detail = $_.Exception.Message }
        return $null
    }
}

# --- Fresh login (old token likely expired) ---
$login = Test-Step "0. Fresh login" {
    Invoke-RestMethod -Uri "$baseUrl/auth/login" -Method Post -ContentType "application/json" `
        -Body '{"email":"test1@example.com","password":"SecurePass123!"}'
}
if (-not $login) { Write-Host "STOPPED - login failed, cannot continue." -ForegroundColor Red; return }
$token = $login.tokens.accessToken
$headers = @{ Authorization = "Bearer $token" }

# --- Use existing child, or create one if none exist ---
$children = Test-Step "0b. List existing children" {
    Invoke-RestMethod -Uri "$baseUrl/children" -Headers $headers -Method Get
}
if ($children.data -and $children.data.Count -gt 0) {
    $childId = $children.data[0].id
} elseif ($children -and $children.Count -gt 0) {
    $childId = $children[0].id
} else {
    $newChild = Test-Step "0c. Create new child" {
        Invoke-RestMethod -Uri "$baseUrl/children" -Headers $headers -Method Post -ContentType "application/json" `
            -Body '{"firstName":"Ahmed","dateOfBirth":"2015-05-10"}'
    }
    $childId = $newChild.id
}
Write-Host "`nUsing childId: $childId" -ForegroundColor Yellow

# --- 3.2 Health Engine ---
Test-Step "3.2 Health - log hydration" {
    Invoke-RestMethod -Uri "$baseUrl/life-intelligence/health/$childId/hydration-logs" -Headers $headers -Method Post -ContentType "application/json" `
        -Body '{"amountMl":250}'
}
Test-Step "3.2 Health - get score" {
    Invoke-RestMethod -Uri "$baseUrl/life-intelligence/health/$childId/score" -Headers $headers -Method Get
}

# --- 3.3 Faith Engine ---
$faithPractice = Test-Step "3.3 Faith - create practice" {
    Invoke-RestMethod -Uri "$baseUrl/life-intelligence/faith/$childId/practices" -Headers $headers -Method Post -ContentType "application/json" `
        -Body '{"type":"SALAH","title":"Fajr Prayer"}'
}
if ($faithPractice) {
    Test-Step "3.3 Faith - log practice" {
        Invoke-RestMethod -Uri "$baseUrl/life-intelligence/faith/$childId/$($faithPractice.id)/log" -Headers $headers -Method Post -ContentType "application/json" -Body '{}'
    }
}
Test-Step "3.3 Faith - get score" {
    Invoke-RestMethod -Uri "$baseUrl/life-intelligence/faith/$childId/score" -Headers $headers -Method Get
}

# --- 3.4 Learning Engine ---
$goal = Test-Step "3.4 Learning - create goal" {
    Invoke-RestMethod -Uri "$baseUrl/life-intelligence/learning/$childId/goals" -Headers $headers -Method Post -ContentType "application/json" `
        -Body '{"subject":"Math","title":"Learn multiplication tables"}'
}
if ($goal) {
    Test-Step "3.4 Learning - log session" {
        Invoke-RestMethod -Uri "$baseUrl/life-intelligence/learning/$childId/sessions" -Headers $headers -Method Post -ContentType "application/json" `
            -Body ('{"goalId":"' + $goal.id + '","subject":"Math","durationMinutes":20,"date":"' + (Get-Date -Format "yyyy-MM-dd") + '"}')
    }
}
Test-Step "3.4 Learning - get progress" {
    Invoke-RestMethod -Uri "$baseUrl/life-intelligence/learning/$childId/progress" -Headers $headers -Method Get
}

# --- 3.5 Smart Tasks ---
Test-Step "3.5 Smart Tasks - generate today" {
    Invoke-RestMethod -Uri "$baseUrl/life-intelligence/smart-tasks/$childId/generate" -Headers $headers -Method Post -ContentType "application/json" `
        -Body '{"lateSleepLastNight":false,"lowHydrationToday":false,"missedHabitsYesterday":[],"screenTimeOverLimit":false}'
}

# --- 3.6 Rewards ---
Test-Step "3.6 Rewards - child account" {
    Invoke-RestMethod -Uri "$baseUrl/life-intelligence/rewards/$childId/account" -Headers $headers -Method Get
}

# --- 3.7 Family Communication ---
Test-Step "3.7 Communication - parent message" {
    Invoke-RestMethod -Uri "$baseUrl/life-intelligence/communication/$childId/parent-message" -Headers $headers -Method Post -ContentType "application/json" `
        -Body '{"category":"encouragement","title":"Great job!","body":"Keep up the good work today."}'
}

# --- 3.8 Coaching ---
Test-Step "3.8 Coaching - recommendations" {
    Invoke-RestMethod -Uri "$baseUrl/life-intelligence/coaching/$childId" -Headers $headers -Method Get
}

# --- 3.9 Digital Twin (the most important one - aggregates everything) ---
$twin = Test-Step "3.9 Digital Twin - full aggregate" {
    Invoke-RestMethod -Uri "$baseUrl/life-intelligence/digital-twin/$childId" -Headers $headers -Method Get
}

# --- 3.10 Life Timeline ---
Test-Step "3.10 Timeline - recorded events" {
    Invoke-RestMethod -Uri "$baseUrl/life-intelligence/timeline/$childId" -Headers $headers -Method Get
}

# --- Phase 5: quick security re-check ---
Test-Step "5.1 Security - access someone else's familyId (must fail)" {
    try {
        Invoke-RestMethod -Uri "$baseUrl/life-intelligence/rewards/store/00000000-0000-0000-0000-000000000000" -Headers $headers -Method Get
        throw "DANGER: request succeeded when it should have been rejected!"
    } catch {
        if ($_.Exception.Response.StatusCode.value__ -in @(403, 404)) {
            return "Correct - rejected with $($_.Exception.Response.StatusCode.value__) as expected"
        }
        throw $_
    }
}

# --- Final summary ---
Write-Host "`n`n========== FINAL SUMMARY ==========" -ForegroundColor Magenta
$results | Format-Table Step, Status -AutoSize
$passCount = ($results | Where-Object { $_.Status -eq "PASS" }).Count
$failCount = ($results | Where-Object { $_.Status -eq "FAIL" }).Count
Write-Host "`nPassed: $passCount | Failed: $failCount" -ForegroundColor $(if ($failCount -eq 0) { "Green" } else { "Yellow" })

Write-Host "`n`n=== Digital Twin - full result (most important for manual review) ===" -ForegroundColor Magenta
$twin | ConvertTo-Json -Depth 10
