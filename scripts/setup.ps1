. "$PSScriptRoot\env.ps1"
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
$env:electron_config_cache = Join-Path (Get-Location) '.cache\electron'
& $TodoLinePnpm install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw '依赖安装失败' }
node scripts/prepare-native.mjs
if ($LASTEXITCODE -ne 0) { throw '数据库运行时安装失败' }
node scripts/build.mjs
if ($LASTEXITCODE -ne 0) { throw '编译失败' }
