param([switch]$NoOpen, [switch]$Real)
$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$baseRoot = Join-Path $projectRoot '.run\hermes-integration'
$runRoot = if ($Real) { Join-Path $baseRoot 'real-20261023' } else { $baseRoot }
$serverInfo = Join-Path $runRoot 'server.json'
$outputLog = Join-Path $runRoot 'server.log'
$errorLog = Join-Path $runRoot 'server-error.log'

function Open-Workbench([string]$Url) {
  Write-Output $Url
  if (-not $NoOpen) {
    try { Start-Process $Url }
    catch { Write-Warning "工作台已就绪，但未能打开浏览器。请手动访问 $Url" }
  }
}

try {
  $port = if ($Real) { 8047 } elseif ($env:HERMES_POC_PORT) { [int]$env:HERMES_POC_PORT } else { 8046 }
  if ($port -lt 1 -or $port -gt 65535) { throw '模拟端口必须在 1–65535 之间。' }
  $expectedUrl = "http://127.0.0.1:$port"
  if (Test-Path -LiteralPath $serverInfo) {
    $known = Get-Content -LiteralPath $serverInfo -Raw | ConvertFrom-Json
    $recordedId = 0
    $recordedAt = [datetimeoffset]::MinValue
    if ($known.url -cne $expectedUrl -or
        -not [int]::TryParse([string]$known.pid, [ref]$recordedId) -or $recordedId -le 0 -or
        -not [datetimeoffset]::TryParse([string]$known.startedAt, [ref]$recordedAt)) {
      throw "实例记录无效或与当前模式不符：$serverInfo。请保留记录并交由维护人员核对，不会自动接管实例。"
    }
    $hasGeneration = $known.PSObject.Properties.Name -contains 'instanceId'
    $generation = [guid]::Empty
    if ($hasGeneration -and
        (-not [guid]::TryParse([string]$known.instanceId, [ref]$generation) -or
         $generation.ToString() -cne [string]$known.instanceId -or
         $known.phase -notin @('starting', 'ready', 'stopping'))) {
      throw '实例代次或阶段记录无效，未接管实例。'
    }
    $process = Get-Process -Id $recordedId -ErrorAction SilentlyContinue
    if ($process) {
      if ($process.ProcessName -ne 'node' -or $process.StartTime.ToUniversalTime() -gt $recordedAt.UtcDateTime) {
        throw "记录中的进程身份已改变，未复用或停止该进程。请核对：$serverInfo"
      }
      $stopName = if ($hasGeneration) { 'stop-' + $generation.ToString() } else { 'stop' }
      if (($hasGeneration -and $known.phase -eq 'stopping') -or
          (Test-Path -LiteralPath (Join-Path $runRoot $stopName))) {
        throw '工作台已收到停止请求，但记录的进程仍在。请等待停止完成，再启动。'
      }
      if ($hasGeneration -and $known.phase -eq 'starting') {
        throw '记录的工作台正在启动，尚未就绪；未重复启动，请稍后再次打开。'
      }
      try { $health = Invoke-RestMethod -Uri "$expectedUrl/health" -TimeoutSec 2 }
      catch { throw '记录的工作台进程仍在，但暂时没有响应。未重复启动；请查看日志或使用停止入口。' }
      if ($health.service -ne 'multi-agent-control-plane' -or $health.status -ne 'ok') {
        throw '记录的工作台进程仍在，但健康状态不符。未重复启动，请先核对日志。'
      }
      Write-Host '工作台已在运行。'
      Open-Workbench $expectedUrl
      exit 0
    }
  }

  foreach ($relativePath in @(
    '.run\hermes-integration\web-dist\index.html',
    'apps\server\dist\server.js',
    'apps\server\dist\runtime-composition.js',
    'apps\server\dist\release-config.js',
    'apps\server\dist\http-shutdown.js',
    'apps\server\dist\windows-lock-delete.cs',
    'integrations\hermes-workbench\instance-lifecycle.mjs',
    'packages\runner\dist\index.js',
    'packages\storage\dist\index.js',
    'packages\core\dist\index.js'
  )) {
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot $relativePath) -PathType Leaf)) {
      throw "缺少现有构建：$relativePath。请由维护人员按部署说明准备；启动器不会自动安装或构建。"
    }
  }
  $nodeCandidates = @(
    (Join-Path $projectRoot 'runtime\node.exe'),
    (Join-Path $projectRoot '.run\collaboration-integration-20261022\delivery-r6-1\Control-Plane-V0-Progress-R6.1-20261022\runtime\node.exe')
  )
  $nodePath = $nodeCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
  if (-not $nodePath) {
    $nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue
    if (-not $nodeCommand) { throw '未找到现有 Node 运行时。请由维护人员准备 runtime\node.exe（含许可）或已有 Node；不会自动安装。' }
    $nodePath = $nodeCommand.Source
  }
  New-Item -ItemType Directory -Path $runRoot -Force | Out-Null
  $entry = if ($Real) { 'integrations/hermes-workbench/serve-real.mjs' } else { 'integrations/hermes-workbench/serve.mjs' }
  $started = Start-Process -FilePath $nodePath -ArgumentList $entry -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $outputLog -RedirectStandardError $errorLog -PassThru
  for ($index = 0; $index -lt 240; $index++) {
    Start-Sleep -Milliseconds 250
    $started.Refresh()
    if ($started.HasExited) { throw "工作台进程提前退出，退出码 $($started.ExitCode)。请查看错误日志。" }
    if (Test-Path -LiteralPath $serverInfo) {
      # The server writes this small file after listening; a concurrent read may see a partial write.
      try { $current = Get-Content -LiteralPath $serverInfo -Raw | ConvertFrom-Json } catch { continue }
      if ($current.pid -eq $started.Id -and $current.url -ceq $expectedUrl -and
          $current.phase -eq 'ready' -and $current.instanceId -match '^[a-f0-9-]{36}$') {
        try { $health = Invoke-RestMethod -Uri "$expectedUrl/health" -TimeoutSec 1 } catch { continue }
        if ($health.service -eq 'multi-agent-control-plane' -and $health.status -eq 'ok') {
          Write-Host '工作台已启动。成员连接检查在后台继续，可以先输入草稿。'
          Open-Workbench $expectedUrl
          exit 0
        }
      }
    }
  }
  throw '尚未确认启动完成，进程可能仍在运行。未自动重启或强制结束；请查看日志，或使用停止入口确认退出。'
} catch {
  [Console]::Error.WriteLine("启动未完成：$($_.Exception.Message)")
  [Console]::Error.WriteLine("运行日志：$outputLog")
  [Console]::Error.WriteLine("错误日志：$errorLog")
  exit 1
}
