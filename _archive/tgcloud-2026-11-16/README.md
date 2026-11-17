# Архив: контур Telegram Serverless (остановлен 2026-11-11)

Сюда перенесён `tgcloud/` из корня проекта: приложение `app8766943850` (вебхук снят,
апдейты забирает мост `news-bridge` на Pi). Оставлено как материал для отката, **не запускать**.

- Прод — `pi/` (служба `newsd` + мост `news-bridge`), правила — `pi/AGENTS.md`.
- Тесты архива остались в корне: `tests/js/` (импортируют `../../_archive/…/tgcloud/lib/…`),
  `npm test` в корне прогоняет именно их.

## Если понадобился откат

```bash
cd ~/Desktop/ai/self/news
npm run config                  # .env → _archive/tgcloud-2026-11-16/tgcloud/lib/secrets.js
npm run status                  # привязка приложения
npm run deploy                  # build-config + npx tgcloud push из каталога архива
npm run migrate -- --safe       # схема платформенной SQLite
```

Порядок отката целиком (снять мост, включить вебхук) — `pi/docs/PROJECT-STATE.md`, раздел 1.
