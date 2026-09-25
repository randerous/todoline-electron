. "$PSScriptRoot\env.ps1"
$qtRoot='E:\Qt\6.8.3\mingw_64'
$mingw='E:\Qt\Tools\mingw1310_64\bin'
$env:PATH="$mingw;$qtRoot\bin;"+$env:PATH
New-Item -ItemType Directory -Force .cache\qt-compat | Out-Null
& "$mingw\g++.exe" -std=c++17 -O2 scripts/qt-compat.cpp -I ../Todoline/src -I "$qtRoot/include" -I "$qtRoot/include/QtCore" -I "$qtRoot/include/QtGui" -I "$qtRoot/include/QtWidgets" -I "$qtRoot/include/QtSql" -I "$qtRoot/include/QtNetwork" ../Todoline/build-win-local/libtlcore.a -L "$qtRoot/lib" -lQt6Widgets -lQt6Gui -lQt6Sql -lQt6Network -lQt6Core -lpsapi -lole32 -o .cache/qt-compat/qt-compat.exe
if ($LASTEXITCODE -ne 0) { throw 'Qt 兼容验证工具编译失败' }
