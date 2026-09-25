. "$PSScriptRoot\env.ps1"
& $TodoLinePnpm typecheck
if ($LASTEXITCODE -ne 0) { throw '类型检查失败' }
& $TodoLinePnpm test
if ($LASTEXITCODE -ne 0) { throw '单元测试失败' }
node scripts/build.mjs
if ($LASTEXITCODE -ne 0) { throw '编译失败' }
if (-not (Test-Path -LiteralPath '.cache\qt-compat\qt-compat.exe') -or (Get-Item -LiteralPath 'scripts\qt-compat.cpp').LastWriteTime -gt (Get-Item -LiteralPath '.cache\qt-compat\qt-compat.exe').LastWriteTime) { & "$PSScriptRoot\build-qt-compat.ps1" }
& $TodoLinePnpm test:e2e
if ($LASTEXITCODE -ne 0) { throw '集成测试失败' }
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_CACHE = Join-Path (Get-Location) '.cache\electron-builder'
& $TodoLinePnpm package
if ($LASTEXITCODE -ne 0) { throw '打包失败' }
