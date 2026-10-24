param([switch]$Real)
$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$folder = if ($Real) { '.run\hermes-integration\real-20261023' } else { '.run\hermes-integration' }
$runRoot = Join-Path $projectRoot $folder
$serverInfo = Join-Path $runRoot 'server.json'

try {
  if (-not (Test-Path -LiteralPath $serverInfo -PathType Leaf)) {
    throw "没有可核对的实例记录：$serverInfo。无法确认是否有启动中的实例；未写停止标记，也未操作其他进程。"
  }
  $known = Get-Content -LiteralPath $serverInfo -Raw | ConvertFrom-Json
  $port = if ($Real) { 8047 } elseif ($env:HERMES_POC_PORT) { [int]$env:HERMES_POC_PORT } else { 8046 }
  $recordedId = 0
  $recordedAt = [datetimeoffset]::MinValue
  if ($port -lt 1 -or $port -gt 65535 -or $known.url -cne "http://127.0.0.1:$port" -or
      -not [int]::TryParse([string]$known.pid, [ref]$recordedId) -or $recordedId -le 0 -or
      -not [datetimeoffset]::TryParse([string]$known.startedAt, [ref]$recordedAt)) {
    throw "实例记录无效或与当前模式不符：$serverInfo。未发送停止请求。"
  }
  $hasGeneration = $known.PSObject.Properties.Name -contains 'instanceId'
  $generation = [guid]::Empty
  if ($hasGeneration -and
      (-not [guid]::TryParse([string]$known.instanceId, [ref]$generation) -or
       $generation.ToString() -cne [string]$known.instanceId -or
       $known.phase -notin @('starting', 'ready', 'stopping'))) {
    throw '实例代次或阶段记录无效，未发送停止请求。'
  }
  $process = Get-Process -Id $recordedId -ErrorAction SilentlyContinue
  if (-not $process) {
    Write-Host '记录的工作台进程已经退出；未操作其他服务。'
    exit 0
  }
  # Metadata is written after startup. A newer process with the same PID is not this instance.
  if ($process.ProcessName -ne 'node' -or $process.StartTime.ToUniversalTime() -gt $recordedAt.UtcDateTime) {
    throw '记录中的进程身份已改变。未写停止标记，也未强制结束进程。'
  }
  $null = $process.Handle
  $stopName = if ($hasGeneration) { 'stop-' + $generation.ToString() } else { 'stop' }
  $stopValue = if ($hasGeneration) { $generation.ToString() } else { 'stop' }
  # New entry points accept only this generation; a delayed old writer cannot stop its successor.
  [IO.File]::WriteAllText((Join-Path $runRoot $stopName), $stopValue, [Text.UTF8Encoding]::new($false))
  Write-Host '已请求正常停止，正在等待记录的工作台进程退出（最多 30 秒）…'
  if (-not $process.WaitForExit(30000)) {
    throw '停止请求已发送，但尚未确认进程退出。请稍后再次使用停止入口并核对日志；此时不要备份、恢复或覆盖数据。'
  }
  Write-Host '记录的工作台进程已退出。历史数据保留。'
  exit 0
} catch {
  [Console]::Error.WriteLine("停止未确认：$($_.Exception.Message)")
  [Console]::Error.WriteLine("错误日志：$(Join-Path $runRoot 'server-error.log')")
  exit 1
}
