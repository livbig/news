#!/usr/bin/env bash
# Деплой новостного агрегатора на Raspberry Pi. Запускается с Mac: bash pi/deploy/deploy.sh
# Идемпотентен: код перезаписывается; база, правила зоны и её настройки — нет.
set -euo pipefail

HOST=${HOST:-pi}
ROOT="$HOME/Desktop/ai/self/news/pi"
ENV_SRC="$HOME/.config/ai/env/news.env"
REMOTE=/srv/news
ZONE_USER=nw-livbig
SERVICE_USER=newsd

say() { printf '\n== %s\n' "$*"; }

# Сверка перед перезаписью: на Pi агент зоны правит код сам, а `rsync --delete` затрёт эти правки
# молча. Расхождения ищет rsync -c, остаются только те, где копия на Pi свежее или её на Mac нет:
# обычные правки Mac деплой не блокируют. FORCE=1 — если правки на Pi не нужны.
check_drift() { # $1 — локальный каталог, $2 — удалённый, дальше — исключения rsync
  local src=$1 dst=$2; shift 2
  local out=() p local_m pi_m
  while IFS= read -r p; do
    case "$p" in ''|*/) continue ;; esac
    local_m=0
    [ -f "$src/$p" ] && local_m=$(stat -f %m "$src/$p" 2>/dev/null || stat -c %Y "$src/$p")
    pi_m=$(ssh "$HOST" "stat -c %Y '$dst/$p' 2>/dev/null || echo 0")
    [ "${pi_m:-0}" -gt "${local_m:-0}" ] && out+=("$p")
  done < <(rsync -ainc --delete --dry-run "$@" "$src/" "$HOST:$dst/" |
            awk '$1 ~ /^[<>]/ || /^\*deleting/ {print $2}')
  [ ${#out[@]} -eq 0 ] && return 0
  printf '\n⚠️  на Pi есть правки, которых нет на Mac (%s):\n' "$dst"
  printf '   %s\n' "${out[@]}"
  [ "${FORCE:-0}" = 1 ] && return 0
  echo 'деплой остановлен: перенеси правки на Mac (бот: «перенеси на Mac») или повтори с FORCE=1'
  exit 1
}

say "0/9 окружение Mac и токен API"
[ -f "$ENV_SRC" ] || { echo "нет $ENV_SRC"; exit 1; }
if ! grep -q '^NEWS_API_TOKEN=' "$ENV_SRC"; then
  printf '\n# токен API службы новостей (фронтенд и инструменты агента)\nNEWS_API_TOKEN=%s\n' "$(openssl rand -hex 24)" >> "$ENV_SRC"
  echo "NEWS_API_TOKEN добавлен в $ENV_SRC"
fi

say "1/9 пользователи и каталоги"
ssh "$HOST" "set -e
  id $SERVICE_USER >/dev/null 2>&1 || sudo useradd --system --home $REMOTE --shell /usr/sbin/nologin $SERVICE_USER
  id $ZONE_USER >/dev/null 2>&1 || sudo useradd --create-home --home-dir $REMOTE/users/livbig --shell /bin/bash $ZONE_USER
  sudo install -d -m 755 -o root -g root $REMOTE
  sudo install -d -m 2775 -o $ZONE_USER -g $SERVICE_USER $REMOTE/server $REMOTE/app
  sudo install -d -m 755 -o root -g root $REMOTE/bridge
  sudo install -d -m 700 -o $SERVICE_USER -g $SERVICE_USER $REMOTE/data $REMOTE/backups
  sudo install -d -m 750 -o root -g $SERVICE_USER $REMOTE/logs
  sudo install -d -m 700 -o $ZONE_USER -g $ZONE_USER \
       $REMOTE/users/livbig $REMOTE/users/livbig/work $REMOTE/users/livbig/pi $REMOTE/users/livbig/tmp \
       $REMOTE/users/livbig/work/files $REMOTE/users/livbig/work/files/inbox $REMOTE/users/livbig/work/files/outbox
  sudo install -d -m 700 -o root -g root /etc/news"

say "2/9 окружение службы (/etc/news/news.env)"
set -a; . "$ENV_SRC"; set +a
TMP_ENV=$(mktemp)
{
  echo "NEWS_BOT_TOKEN=${TELEGRAM_TOKEN:-${NEWS_BOT_TOKEN:-}}"
  # Мост Дворецкого читает токен как HELPER_BOT_TOKEN (родное имя), PI_TG_* — совместимость.
  echo "HELPER_BOT_TOKEN=${TELEGRAM_TOKEN:-${NEWS_BOT_TOKEN:-}}"
  echo "PI_TG_BOT_TOKEN=${TELEGRAM_TOKEN:-${NEWS_BOT_TOKEN:-}}"
  echo "NEWS_CHAT_ID=${TELEGRAM_CHAT_ID:-${NEWS_CHAT_ID:-}}"
  # Страховка на случай потери профилей: белый список моста — тот же единственный чат.
  echo "PI_TG_ALLOWED_USER_IDS=${TELEGRAM_CHAT_ID:-${NEWS_CHAT_ID:-}}"
  echo "NEWS_API_TOKEN=${NEWS_API_TOKEN}"
  echo "NEWS_API_PORT=8097"
  echo "NEWS_API_HOST=0.0.0.0"
  echo "NEWS_DB=$REMOTE/data/news.db"
  echo "NEWS_TZ_OFFSET_MIN=180"
  echo "NEWS_DIGEST_TIMES=09:00,21:00"
  echo "NEWS_COLLECT_INTERVAL_MIN=20"
  echo "NEWS_ANALYZE_EVERY_MIN=5"
  echo "NEWS_ANALYZE_BATCH=40"
  echo "NEWS_MAX_PAGES_PER_CHANNEL=6"
  echo "LLM_API_KEY=${LLM_API_KEY:-}"
  echo "LLM_BASE_URL=${LLM_BASE_URL:-https://api.deepseek.com/anthropic}"
  echo "LLM_MODEL=${LLM_MODEL:-deepseek-flash}"
  echo "LLM_EFFORT=${LLM_EFFORT:-max}"
  echo "LLM_THINKING=${LLM_THINKING:-enabled}"
  echo "LLM_MAX_TOKENS=${LLM_MAX_TOKENS:-96000}"
  # Тот же ключ, но под именами, которые читает pi в зоне (как у Дворецкого).
  echo "DEEPSEEK_API_KEY=${LLM_API_KEY:-}"
  echo "DEEPSEEK_BASE_URL=https://api.deepseek.com"
  echo "DEEPSEEK_MODEL=deepseek-flash"
  echo "THINKING_LEVEL=high"
  # Голосовые в чате: ключ OpenRouter и модель STT (как у Дворцкого).
  echo "OPENROUTER_API_KEY=${OPENROUTER_API_KEY:-}"
  echo "STT_BASE_URL=${STT_BASE_URL:-https://openrouter.ai/api/v1}"
  echo "STT_MODEL=${STT_MODEL:-openai/whisper-large-v3}"
  echo "STT_LANGUAGE=${STT_LANGUAGE:-ru}"
  echo "TZ=Europe/Moscow"
} > "$TMP_ENV"
[ -s "$TMP_ENV" ] || { echo "пустое окружение"; exit 1; }
scp -q "$TMP_ENV" "$HOST:/tmp/news.env"
rm -f "$TMP_ENV"
ssh "$HOST" "sudo install -m 600 -o root -g root /tmp/news.env /etc/news/news.env && rm /tmp/news.env"

say "3/9 код"
# restart.request и fact-day-override — рабочие метки самого Pi (в .gitignore), их не синхронизируем.
check_drift "$ROOT/server" "$REMOTE/server" --exclude node_modules --exclude .git --exclude restart.request --exclude fact-day-override
check_drift "$ROOT/app" "$REMOTE/app" --exclude node_modules --exclude .git
rsync -az --delete --rsync-path="sudo rsync" --exclude node_modules --exclude .git --exclude test-results \
  --exclude restart.request --exclude fact-day-override \
  "$ROOT/server/" "$HOST:$REMOTE/server/"
rsync -az --delete --rsync-path="sudo rsync" --exclude node_modules --exclude .git \
  "$ROOT/app/" "$HOST:$REMOTE/app/"
rsync -az --delete --rsync-path="sudo rsync" --exclude node_modules --exclude .git --exclude .env --exclude bridge.log \
  "$ROOT/bridge/" "$HOST:$REMOTE/bridge/"
ssh "$HOST" "set -e
  sudo chown -R $ZONE_USER:$SERVICE_USER $REMOTE/server $REMOTE/app
  sudo find $REMOTE/server $REMOTE/app -type d -exec chmod 2775 {} +
  sudo find $REMOTE/server $REMOTE/app -type f -exec chmod 664 {} +
  sudo chown -R root:root $REMOTE/bridge
  sudo chmod -R go-w $REMOTE/bridge"

say "4/9 зависимости моста"
ssh "$HOST" "cd $REMOTE/bridge && sudo npm ci --no-audit --no-fund 2>&1 | tail -2"

say "5/9 юниты, таймеры, sudoers"
scp -q "$ROOT"/deploy/news-*.service "$ROOT"/deploy/news-*.timer \
  "$ROOT/deploy/newsd.service" "$ROOT/deploy/news-task@.service" "$HOST:/tmp/"
scp -q "$ROOT/deploy/news-agent.sudoers" "$HOST:/tmp/news-agent.sudoers"
ssh "$HOST" "set -e
  for unit in newsd news-bridge news-heartbeat news-backup news-upkeep; do
    sudo install -m 644 /tmp/\$unit.service /etc/systemd/system/
  done
  for timer in news-heartbeat news-backup news-upkeep; do
    sudo install -m 644 /tmp/\$timer.timer /etc/systemd/system/
  done
  sudo install -m 644 "/tmp/news-task@.service" /etc/systemd/system/
  rm -f /tmp/news-*.service /tmp/news-*.timer /tmp/newsd.service "/tmp/news-task@.service"
  sudo visudo -cf /tmp/news-agent.sudoers >/dev/null
  sudo install -m 440 -o root -g root /tmp/news-agent.sudoers /etc/sudoers.d/news-agent && rm /tmp/news-agent.sudoers
  sudo systemctl daemon-reload
  sudo systemctl enable newsd.service news-bridge.service >/dev/null
  sudo systemctl enable news-heartbeat.timer news-backup.timer news-upkeep.timer >/dev/null"

say "6/9 настройки и правила зоны"
scp -q "$ROOT/deploy/zone-pi-settings.json" "$HOST:/tmp/zone-pi-settings.json"
ssh "$HOST" "set -e
  if [ ! -f $REMOTE/users/livbig/pi/settings.json ]; then
    sudo install -m 600 -o $ZONE_USER -g $ZONE_USER /tmp/zone-pi-settings.json $REMOTE/users/livbig/pi/settings.json
  fi
  rm -f /tmp/zone-pi-settings.json"
if ssh "$HOST" "sudo test -f $REMOTE/users/livbig/work/AGENTS.md"; then
  echo "правила зоны уже есть — не перезаписываю"
else
  scp -q "$ROOT/users/livbig-agents.md" "$HOST:/tmp/livbig-agents.md"
  ssh "$HOST" "sudo install -m 600 -o $ZONE_USER -g $ZONE_USER /tmp/livbig-agents.md $REMOTE/users/livbig/work/AGENTS.md && rm /tmp/livbig-agents.md"
fi

say "7/9 запуск службы (она сама сеет источники) и проверка API"
ssh "$HOST" "set -e
  sudo systemctl restart newsd.service
  for i in \$(seq 1 20); do
    if curl -sf -m 3 http://127.0.0.1:8097/api/health >/dev/null; then break; fi
    sleep 1
  done
  systemctl is-active newsd.service
  TOKEN=\$(sudo grep '^NEWS_API_TOKEN=' /etc/news/news.env | cut -d= -f2)
  curl -s -m 5 -H \"Authorization: Bearer \$TOKEN\" http://127.0.0.1:8097/api/state" | head -c 900

say "8/9 мост: снять вебхук, перезапуск"
ssh "$HOST" "sudo bash -c 'set -a; . /etc/news/news.env; set +a; NODE_OPTIONS=--experimental-sqlite /usr/bin/node $REMOTE/server/scripts/webhook.mjs delete'" | tail -8
ssh "$HOST" "set -e
  sudo systemctl restart news-bridge.service
  sleep 5
  systemctl is-active news-bridge.service"

say "9/9 здоровье"
ssh "$HOST" "set +e
  TOKEN=\$(sudo grep '^NEWS_API_TOKEN=' /etc/news/news.env | cut -d= -f2)
  echo '--- health'; curl -s -m 5 http://127.0.0.1:8097/api/health; echo
  echo '--- состояние'; curl -s -m 5 -H \"Authorization: Bearer \$TOKEN\" http://127.0.0.1:8097/api/state | head -c 700; echo
  echo '--- баннер моста'; journalctl -u news-bridge -n 6 --no-pager"

say "готово: служба, мост и таймеры на Pi"
