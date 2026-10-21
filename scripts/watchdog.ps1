# Keeps the funnel server alive for a demo: checks every 10 seconds, restarts it if it stops,
# keeps Windows awake, and logs tunnel problems.   powershell -File scripts\watchdog.ps1 -Minutes 40
param([int]$Minutes = 40)
$wd = Split-Path -Parent $PSScriptRoot
$log = Join-Path $wd 'watchdog.log'
$node = (Get-Command node).Source
function Log($m) { "$(Get-Date -Format 'HH:mm:ss') $m" | Add-Content -Path $log }

Add-Type -Namespace Win -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'
# ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED : no sleep while this script runs
[void][Win.Power]::SetThreadExecutionState([uint32]2147483651)

$publicUrl = ((Get-Content (Join-Path $wd '.env') | Where-Object { $_ -match '^PUBLIC_URL=' } | Select-Object -First 1) -replace '^PUBLIC_URL=', '').Trim()
Log "watchdog started for $Minutes min, public url $publicUrl"
$end = (Get-Date).AddMinutes($Minutes)
$downCount = 0
$tunnelWarned = $false
while ((Get-Date) -lt $end) {
  $ok = $false
  try { $ok = (Invoke-RestMethod -Uri 'http://localhost:3000/api/health' -TimeoutSec 4).ok -eq $true } catch { $ok = $false }
  if (-not $ok) {
    $downCount++
    if ($downCount -ge 2) { # two failed checks in a row, so a brief hiccup does not trigger a restart
      Log 'server down, restarting'
      Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'src[\\/]index\.js' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
      Start-Sleep -Seconds 1
      Start-Process -FilePath $node -ArgumentList 'core/index.js' -WorkingDirectory $wd -WindowStyle Hidden -RedirectStandardOutput (Join-Path $wd 'server.log') -RedirectStandardError (Join-Path $wd 'server.err.log')
      Start-Sleep -Seconds 5
      $downCount = 0
    }
  } else { $downCount = 0 }
  try {
    $t = Invoke-RestMethod -Uri 'http://127.0.0.1:4040/api/tunnels' -TimeoutSec 4
    $has = @($t.tunnels | Where-Object { $_.public_url -eq $publicUrl }).Count -gt 0
    if (-not $has -and -not $tunnelWarned) { Log "TUNNEL MISSING: $publicUrl is not open in ngrok"; $tunnelWarned = $true }
    if ($has -and $tunnelWarned) { Log 'tunnel is back'; $tunnelWarned = $false }
  } catch { if (-not $tunnelWarned) { Log 'TUNNEL: ngrok agent not reachable'; $tunnelWarned = $true } }
  Start-Sleep -Seconds 10
}
[void][Win.Power]::SetThreadExecutionState([uint32]2147483648)
Log 'watchdog finished'
