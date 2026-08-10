# Ebni — سكريبت التحقق الشامل (يشغّل المراحل 3-5 المتبقية دفعة واحدة)
# طريقة الاستخدام: افتح PowerShell (مش CMD) في أي مكان، الصق السكريبت كامل، دوس Enter.
# في الآخر هتلاقي كل النتائج مطبوعة بالترتيب + ملخّص نهائي واضح.

$ErrorActionPreference = "Continue"
$baseUrl = "https://familyos-production-74ca.up.railway.app/api/v1"
$results = @()

function Test-Step {
    param($Name, $ScriptBlock)
    Write-Host "`n=== $Name ===" -ForegroundColor Cyan
    try {
        $result = & $ScriptBlock
        Write-Host "✅ نجح" -ForegroundColor Green
        $script:results += [PSCustomObject]@{ Step = $Name; Status = "PASS"; Detail = ($result | ConvertTo-Json -Compress -Depth 5) }
        return $result
    } catch {
        Write-Host "❌ فشل: $($_.Exception.Message)" -ForegroundColor Red
        if ($_.ErrorDetails.Message) { Write-Host $_.ErrorDetails.Message -ForegroundColor Red }
        $script:results += [PSCustomObject]@{ Step = $Name; Status = "FAIL"; Detail = $_.Exception.Message }
        return $null
    }
}

# --- إعادة تسجيل الدخول (التوكين القديم غالبًا منتهي) ---
$login = Test-Step "0. تسجيل دخول جديد" {
    Invoke-RestMethod -Uri "$baseUrl/auth/login" -Method Post -ContentType "application/json" `
        -Body '{"email":"test1@example.com","password":"SecurePass123!"}'
}
if (-not $login) { Write-Host "توقف — تسجيل الدخول فشل، مينفعش نكمل." -ForegroundColor Red; return }
$token = $login.tokens.accessToken
$headers = @{ Authorization = "Bearer $token" }

# --- استخدام أول طفل موجود، أو إنشاء واحد جديد لو مفيش ---
$children = Test-Step "0b. سرد الأطفال الموجودين" {
    Invoke-RestMethod -Uri "$baseUrl/children" -Headers $headers -Method Get
}
if ($children.data -and $children.data.Count -gt 0) {
    $childId = $children.data[0].id
} elseif ($children -and $children.Count -gt 0) {
    $childId = $children[0].id
} else {
    $newChild = Test-Step "0c. إنشاء طفل جديد" {
        Invoke-RestMethod -Uri "$baseUrl/children" -Headers $headers -Method Post -ContentType "application/json" `
            -Body '{"firstName":"Ahmed","dateOfBirth":"2015-05-10"}'
    }
    $childId = $newChild.id
}
Write-Host "`nchildId المُستخدَم: $childId" -ForegroundColor Yellow

# --- 3.2 Health Engine ---
Test-Step "3.2 Health: تسجيل شرب مياه" {
    Invoke-RestMethod -Uri "$baseUrl/life-intelligence/health/$childId/hydration-logs" -Headers $headers -Method Post -ContentType "application/json" `
        -Body '{"amountMl":250}'
}
Test-Step "3.2 Health: التحقق من Score" {
    Invoke-RestMethod -Uri "$baseUrl/life-intelligence/health/$childId/score" -Headers $headers -Method Get
}

# --- 3.3 Faith Engine ---
$faithPractice = Test-Step "3.3 Faith: إنشاء ممارسة" {
    Invoke-RestMethod -Uri "$baseUrl/life-intelligence/faith/$childId/practices" -Headers $headers -Method Post -ContentType "application/json" `
        -Body '{"type":"SALAH","title":"Fajr Prayer"}'
}
if ($faithPractice) {
    Test-Step "3.3 Faith: تسجيل الممارسة" {
        Invoke-RestMethod -Uri "$baseUrl/life-intelligence/faith/$childId/$($faithPractice.id)/log" -Headers $headers -Method Post -ContentType "application/json" -Body '{}'
    }
}
Test-Step "3.3 Faith: التحقق من Score" {
    Invoke-RestMethod -Uri "$baseUrl/life-intelligence/faith/$childId/score" -Headers $headers -Method Get
}

# --- 3.4 Learning Engine ---
$goal = Test-Step "3.4 Learning: إنشاء هدف" {
    Invoke-RestMethod -Uri "$baseUrl/life-intelligence/learning/$childId/goals" -Headers $headers -Method Post -ContentType "application/json" `
        -Body '{"subject":"Math","title":"Learn multiplication tables"}'
}
if ($goal) {
    Test-Step "3.4 Learning: تسجيل جلسة" {
        Invoke-RestMethod -Uri "$baseUrl/life-intelligence/learning/$childId/sessions" -Headers $headers -Method Post -ContentType "application/json" `
            -Body ('{"goalId":"' + $goal.id + '","subject":"Math","durationMinutes":20,"date":"' + (Get-Date -Format "yyyy-MM-dd") + '"}')
    }
}
Test-Step "3.4 Learning: التحقق من التقدّم" {
    Invoke-RestMethod -Uri "$baseUrl/life-intelligence/learning/$childId/progress" -Headers $headers -Method Get
}

# --- 3.5 Smart Tasks ---
Test-Step "3.5 Smart Tasks: توليد مهام اليوم" {
    Invoke-RestMethod -Uri "$baseUrl/life-intelligence/smart-tasks/$childId/generate" -Headers $headers -Method Post -ContentType "application/json" `
        -Body '{"lateSleepLastNight":false,"lowHydrationToday":false,"missedHabitsYesterday":[],"screenTimeOverLimit":false}'
}

# --- 3.6 Rewards ---
Test-Step "3.6 Rewards: محفظة الطفل" {
    Invoke-RestMethod -Uri "$baseUrl/life-intelligence/rewards/$childId/account" -Headers $headers -Method Get
}

# --- 3.7 Family Communication ---
Test-Step "3.7 Communication: رسالة من الأب" {
    Invoke-RestMethod -Uri "$baseUrl/life-intelligence/communication/$childId/parent-message" -Headers $headers -Method Post -ContentType "application/json" `
        -Body '{"category":"encouragement","title":"Great job!","body":"Keep up the good work today."}'
}

# --- 3.8 Coaching ---
Test-Step "3.8 Coaching: توصيات" {
    Invoke-RestMethod -Uri "$baseUrl/life-intelligence/coaching/$childId" -Headers $headers -Method Get
}

# --- 3.9 Digital Twin (الأهم — يجمع كل المحركات) ---
$twin = Test-Step "3.9 Digital Twin: التوأم الرقمي الكامل" {
    Invoke-RestMethod -Uri "$baseUrl/life-intelligence/digital-twin/$childId" -Headers $headers -Method Get
}

# --- 3.10 Life Timeline ---
Test-Step "3.10 Timeline: الأحداث المُسجَّلة" {
    Invoke-RestMethod -Uri "$baseUrl/life-intelligence/timeline/$childId" -Headers $headers -Method Get
}

# --- المرحلة 5: إعادة تحقق أمنية سريعة ---
Test-Step "5.1 أمان: محاولة الوصول لـ familyId مش بتاعي (لازم يفشل)" {
    try {
        Invoke-RestMethod -Uri "$baseUrl/life-intelligence/rewards/store/00000000-0000-0000-0000-000000000000" -Headers $headers -Method Get
        throw "خطر: الطلب نجح رغم إنه مفروض يترفض!"
    } catch {
        if ($_.Exception.Response.StatusCode.value__ -in @(403, 404)) {
            return "صح — اترفض بـ $($_.Exception.Response.StatusCode.value__) زي المتوقَّع"
        }
        throw $_
    }
}

# --- الملخّص النهائي ---
Write-Host "`n`n========== الملخّص النهائي ==========" -ForegroundColor Magenta
$results | Format-Table Step, Status -AutoSize
$passCount = ($results | Where-Object { $_.Status -eq "PASS" }).Count
$failCount = ($results | Where-Object { $_.Status -eq "FAIL" }).Count
Write-Host "`nناجح: $passCount | فاشل: $failCount" -ForegroundColor $(if ($failCount -eq 0) { "Green" } else { "Yellow" })

Write-Host "`n`n=== Digital Twin — النتيجة الكاملة (الأهم للمراجعة اليدوية) ===" -ForegroundColor Magenta
$twin | ConvertTo-Json -Depth 10
