# Выкладка на сервер 1233.chat: забрать свежий код из GitHub, пересобрать тренажёр
# (hsk.1233.chat) и бота, перезапустить оба. Запускать со своего компьютера
# после git push, из PowerShell:
#   .\deploy\update-server.ps1
# Нужна и после правки колод: бот читает их только при запуске.
# Файл сохранён в UTF-8 с BOM — иначе Windows PowerShell 5.1 портит русские буквы.

$server = if ($env:HSK_SERVER) { $env:HSK_SERVER } else { "root@104.248.206.64" }

Set-Location (Join-Path $PSScriptRoot "..")
git fetch -q origin master
if (git status --porcelain --untracked-files=no) {
    Write-Warning "Есть незакоммиченные изменения: на сервер они не попадут."
}
if ((git rev-parse HEAD) -ne (git rev-parse origin/master)) {
    Write-Warning "Локальный коммит не совпадает с origin/master: на сервер уйдёт то, что лежит на GitHub."
}

# Одной строкой: так в команду не попадают переводы строк Windows. Внутри только
# одинарные кавычки: двойные Windows PowerShell 5.1 теряет при передаче в ssh.
$remote = 'set -e; cd /opt/catboard/chinese-drill-bot; git pull -q --ff-only; echo ''Код на сервере:'' $(git log --oneline -1); ' +
    'cd /opt/catboard/Cat-Board; docker compose --profile hsk up -d --build --no-deps hsk hsk-bot 2>&1 | tail -4; sleep 8; ' +
    'docker ps -a --filter name=catboard-hsk --format ''{{.Names}}: {{.Status}}''; echo ''Последние строки бота:''; docker logs --tail 3 catboard-hsk-bot 2>&1'

ssh $server $remote
if ($LASTEXITCODE -ne 0) { Write-Error "Выкладка не удалась (код $LASTEXITCODE)."; exit $LASTEXITCODE }
