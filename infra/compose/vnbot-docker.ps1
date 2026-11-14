param(
    [ValidateSet('Start', 'Stop', 'Status', 'Configure', 'RepairSandbox')]
    [string]$Action = 'Start'
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$source = Join-Path $root 'source'
$envFile = Join-Path $root '.env'
$url = 'http://127.0.0.1:54173'
$project = 'vnbot-ai-test'

function New-Secret {
    $bytes = New-Object byte[] 32
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
    return ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
}

function Set-Mail {
    param([string]$Content)
    Write-Host 'Cau hinh mail nhan ma dang nhap. Chi luu tren may nay.'
    $server = Read-Host 'May chu SMTP (vi du smtp.gmail.com)'
    if ($server -notmatch '^[a-zA-Z0-9.-]+$') { throw 'Ten may chu SMTP khong hop le.' }
    $portText = Read-Host 'Cong SMTP (Enter de dung 465)'
    $port = 465
    if ($portText -and (-not [int]::TryParse($portText, [ref]$port))) { throw 'Cong SMTP khong hop le.' }
    if ($port -lt 1 -or $port -gt 65535) { throw 'Cong SMTP khong hop le.' }
    $login = Read-Host 'Tai khoan SMTP'
    if ([string]::IsNullOrWhiteSpace($login)) { throw 'Can tai khoan SMTP.' }
    $password = Read-Host 'Mat khau SMTP / mat khau ung dung (an khi nhap)' -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($password)
    try {
        $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
        if (-not $plain) { throw 'Can mat khau SMTP.' }
        $scheme = if ($port -eq 465) { 'smtps' } else { 'smtp' }
        $smtp = '{0}://{1}:{2}@{3}:{4}' -f $scheme, [Uri]::EscapeDataString($login), [Uri]::EscapeDataString($plain), $server, $port
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
        $plain = $null
        $password.Dispose()
    }
    $sender = Read-Host 'Email gui ma dang nhap'
    try { $address = New-Object System.Net.Mail.MailAddress($sender) } catch { throw 'Email gui khong hop le.' }
    if ($address.Address -ne $sender -or $sender -match "['\r\n]") { throw 'Chi nhap dia chi email gui.' }
    $Content = [regex]::Replace($Content, '(?m)^SMTP_URL=.*$', "SMTP_URL='$smtp'")
    return [regex]::Replace($Content, '(?m)^EMAIL_FROM=.*$', "EMAIL_FROM='VNBot <$sender>'")
}

function Invoke-Docker {
    param([string[]]$DockerArguments)
    & docker @DockerArguments
    if ($LASTEXITCODE -ne 0) { throw 'Docker bao loi. Giu cua so nay de xem dong loi phia tren.' }
}

function Import-PrivateMail {
    param([string]$Content, [string]$File)
    try {
        $item = Get-Item -Force -LiteralPath $File
        if ($item.Length -gt 16384 -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Invalid file' }
        $mail = [IO.File]::ReadAllText($File) | ConvertFrom-Json
        if ($mail.smtpUrl -isnot [string] -or $mail.from -isnot [string]) { throw 'Invalid fields' }
        $smtp = [uri]$mail.smtpUrl
        if ($smtp.Scheme -notin @('smtp', 'smtps') -or -not $smtp.Host -or -not $smtp.UserInfo) { throw 'Invalid SMTP' }
        if ($mail.smtpUrl -match "['\r\n]" -or $mail.from -match "['\r\n]") { throw 'Invalid value' }
        $null = New-Object System.Net.Mail.MailAddress($mail.from)
        return (($Content -split "`n" | ForEach-Object {
            if ($_.StartsWith('SMTP_URL=')) { "SMTP_URL='$($mail.smtpUrl)'" }
            elseif ($_.StartsWith('EMAIL_FROM=')) { "EMAIL_FROM='$($mail.from)'" }
            else { $_ }
        }) -join "`n")
    } catch {
        # Parser errors can contain the input. Never print a credential-bearing value.
        throw 'File mail rieng khong hop le. Giu nguyen file va bao lai de nhan ban sua.'
    }
}

$savedEnvironment = @{}
try {
    if (-not (Test-Path (Join-Path $source 'infra/compose/docker-compose.yml'))) {
        throw 'Hay giai nen toan bo file ZIP roi chay CHAY-VNBOT.cmd trong thu muc VNBot-Docker.'
    }
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        throw 'Can cai va mo Docker Desktop, chon Linux containers, roi chay lai.'
    }
    # The bundle owns its settings. Ambient Compose/credential variables must not
    # redirect this local test or silently replace its generated keys.
    $composePaths = @(
        (Join-Path $source 'infra/compose/docker-compose.yml'),
        (Join-Path $source 'infra/compose/docker-compose.vnbot-preview.yml')
    )
    $composeText = ($composePaths | ForEach-Object { [IO.File]::ReadAllText($_) }) -join "`n"
    $names = @([regex]::Matches($composeText, '(?m)^\s+([A-Z][A-Z0-9_]+):|\$\{([A-Za-z_][A-Za-z0-9_]*)') | ForEach-Object {
        if ($_.Groups[1].Success) { $_.Groups[1].Value } else { $_.Groups[2].Value }
    })
    $names += 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'DOCKER_DEFAULT_PLATFORM'
    foreach ($entry in @(Get-ChildItem Env:)) {
        if ($entry.Name -like 'COMPOSE_*' -or $names -contains $entry.Name) {
            $savedEnvironment[$entry.Name] = $entry.Value
            Remove-Item ('Env:' + $entry.Name)
        }
    }
    $context = (& docker context show | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $context) { throw 'Khong doc duoc Docker context.' }
    $endpoint = (& docker context inspect $context --format '{{.Endpoints.docker.Host}}' | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $endpoint -notmatch '^(unix://|npipe://)') {
        throw 'Hay chon Docker Desktop tren may nay. Goi thu khong chay tren Docker tu xa.'
    }
    $engine = (& docker --context $context info --format '{{.OSType}}' | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $engine -ne 'linux') { throw 'Hay mo Docker Desktop va chuyen sang Linux containers.' }
    $versionText = (& docker --context $context compose version --short | Out-String).Trim().TrimStart('v')
    if ($LASTEXITCODE -ne 0 -or [version]($versionText.Split('-')[0]) -lt [version]'2.24.4') {
        throw 'Can Docker Compose 2.24.4 tro len. Hay cap nhat Docker Desktop.'
    }
    $created = $false
    if (Test-Path $envFile) {
        if ((Get-Item -Force $envFile).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'File .env phai la file thuong.' }
    } elseif ($Action -in @('Stop', 'Status', 'RepairSandbox')) {
        throw 'Chua cai. Hay chay CHAY-VNBOT.cmd truoc.'
    } else {
        $settings = [ordered]@{
            POSTGRES_PASSWORD = (New-Secret)
            POSTGRES_APP_PASSWORD = (New-Secret)
            BETTER_AUTH_SECRET = (New-Secret)
            ENCRYPTION_KEY = (New-Secret)
            SANDBOX_SUPERVISOR_TOKEN = (New-Secret)
            SCREEN_PROXY_SECRET = (New-Secret)
            NODE_ENV = 'production'
            SIGNUPS_ENABLED = 'true'
            SMTP_URL = ''
            EMAIL_FROM = ''
            API_URL = $url
            WEB_ORIGIN = $url
            BETTER_AUTH_URL = $url
        }
        $content = ($settings.GetEnumerator() | ForEach-Object { "{0}='{1}'" -f $_.Key, $_.Value }) -join "`n"
        $privateMail = Join-Path $root 'mail.private.json'
        if (Test-Path -LiteralPath $privateMail) {
            $content = Import-PrivateMail $content $privateMail
        } else {
            $content = Set-Mail $content
        }
        [IO.File]::WriteAllText($envFile, $content + "`n", (New-Object Text.UTF8Encoding($false)))
        $created = $true
    }
    if ($Action -eq 'Configure') {
        if (-not $created) {
            $content = Set-Mail ([IO.File]::ReadAllText($envFile))
            [IO.File]::WriteAllText($envFile, $content, (New-Object Text.UTF8Encoding($false)))
        }
        Write-Host 'Da luu mail. Chay lai CHAY-VNBOT.cmd de ap dung.'
        exit 0
    }
    $compose = @('--context', $context, 'compose', '--project-name', $project, '--env-file', $envFile)
    foreach ($file in $composePaths) { $compose += @('-f', $file) }
    Invoke-Docker ($compose + @('config', '--quiet'))
    switch ($Action) {
        'RepairSandbox' {
            $system = (& docker --context $context info --format '{{.OperatingSystem}}' | Out-String).Trim()
            if ($LASTEXITCODE -ne 0 -or $system -notmatch 'Docker Desktop') {
                throw 'Ban va nay chi danh cho Docker Desktop tren may thu rieng.'
            }
            $overlay = $composePaths[1]
            if ((Get-Item -Force $overlay).Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw 'File cau hinh sandbox phai la file thuong.'
            }
            $original = [IO.File]::ReadAllText($overlay)
            $egressMatches = [regex]::Matches($original, '(?m)^([ \t]+)SANDBOX_COMPUTER_EGRESS:[ \t]*(restricted|open)[ \t]*\r?$')
            if ($egressMatches.Count -ne 1) { throw 'Cau hinh sandbox da khac ban thu. Khong tu sua.' }
            Write-Host 'Ban thu se dung mang OPEN: bot co the truy cap dich vu tren may va mang noi bo.' -ForegroundColor Yellow
            Write-Host 'Chi dung tren may thu rieng. Khong xoa du lieu, khong sua firewall cua may.'
            if ((Read-Host 'Go DONG Y de ap dung, hoac Enter de huy') -cne 'DONG Y') {
                Write-Host 'Da huy. Khong thay doi cau hinh.'
                break
            }
            if ($egressMatches[0].Groups[2].Value -eq 'restricted') {
                $backup = Join-Path $root 'sandbox-network.before-fix.yml'
                if (-not (Test-Path -LiteralPath $backup)) { [IO.File]::Copy($overlay, $backup, $false) }
                $updated = $original.Replace($egressMatches[0].Value, $egressMatches[0].Groups[1].Value + 'SANDBOX_COMPUTER_EGRESS: open')
                [IO.File]::WriteAllText($overlay, $updated, (New-Object Text.UTF8Encoding($false)))
            }
            Invoke-Docker ($compose + @('config', '--quiet'))
            Invoke-Docker ($compose + @('up', '--detach', '--no-deps', '--no-build', '--wait', '--wait-timeout', '120', 'supervisor'))
            $runtimeMode = (Invoke-Docker ($compose + @('exec', '-T', 'supervisor', 'node', '-p', 'process.env.SANDBOX_COMPUTER_EGRESS')) | Out-String).Trim()
            if ($runtimeMode -cne 'open') { throw 'Dich vu sandbox chua nhan cau hinh moi. Khong bao sua thanh cong.' }
            Write-Host 'Da ap dung mang OPEN cho sandbox. Quay lai VNBot va gui lai tin nhan.'
        }
        'Stop' { Invoke-Docker ($compose + @('stop')); Write-Host 'Da dung. Du lieu van giu nguyen.' }
        'Status' { Invoke-Docker ($compose + @('ps')) }
        'Start' {
            Write-Host 'Dang dung va mo VNBot. Lan dau can Internet va co the mat nhieu phut.'
            Invoke-Docker ($compose + @('up', '--build', '--detach', '--wait', '--wait-timeout', '600'))
            $page = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 30
            if ($page.StatusCode -ne 200) { throw 'Giao dien chua san sang. Chay KIEM-TRA.cmd de xem trang thai.' }
            Write-Host "VNBot san sang: $url"
            Start-Process $url
        }
    }
} catch {
    Write-Host ('Loi: ' + $_.Exception.Message) -ForegroundColor Red
    exit 1
} finally {
    foreach ($name in $savedEnvironment.Keys) { Set-Item ('Env:' + $name) $savedEnvironment[$name] }
}
