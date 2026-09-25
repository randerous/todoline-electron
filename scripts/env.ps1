$ErrorActionPreference = 'Stop'
$taskNode = Get-Command node -ErrorAction SilentlyContinue
if (-not $taskNode) {
    $taskNodeFile = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
    if (-not (Test-Path -LiteralPath $taskNodeFile)) { throw '请先安装 Node.js 24 LTS，再运行此脚本。' }
    $env:PATH = (Split-Path $taskNodeFile) + ';' + $env:PATH
}
$taskPnpm = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
if ($taskPnpm) { $script:TodoLinePnpm = $taskPnpm.Source }
else {
    $script:TodoLinePnpm = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd'
    if (-not (Test-Path -LiteralPath $script:TodoLinePnpm)) { throw '请先安装 pnpm 11，再运行此脚本。' }
}
$env:PATH = (Split-Path $script:TodoLinePnpm) + ';' + $env:PATH
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Set-Location (Split-Path $PSScriptRoot)
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
$env:electron_config_cache = Join-Path (Get-Location) '.cache\electron'
