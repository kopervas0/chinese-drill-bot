#!/usr/bin/env bash
# Обновление бота на VM: забрать код, собрать, перезапустить сервис.
# Запускать на VM от обычного пользователя (не drillbot): bash deploy/update.sh
set -euo pipefail

cd "$(dirname "$0")/.."
git pull --ff-only
npm ci
npm run build
npm prune --omit=dev
sudo systemctl restart chinese-drill-bot
sudo systemctl --no-pager status chinese-drill-bot | head -n 5
