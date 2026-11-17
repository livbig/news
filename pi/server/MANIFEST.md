# Перенос правок с Pi на Mac (источник правды)

Эти файлы — рабочая версия с Raspberry Pi. Они новее того, что лежит в репозитории
на MacBook, поэтому каждый `deploy/deploy.sh` откатывал их и ломал то, что владелец уже видел
в чате (порядок разделов, ссылки-эмодзи, рубрику «100 дней», квизы).

## Что включено

Код:
- `src/daily-fact.js` — рубрика «Physical AI и роботы»: курс на 100 дней (7 блоков),
  промпт (факт → пример → почему важно → на практике → схема → квиз → новинки рынка),
  санитайзер HTML (только b/i/a/pre), парсер квизов, запуск одного дня.
- `src/visual.js` — визуал: схема из `<pre>` рендерится в PNG (python3 + Pillow),
  отправка картинки через `sendPhoto` (multipart).
- `src/reload.js` — самоперезапуск службы по метке `restart.request` (без root).
- `scripts/render_scheme.py` — рендер карточки-схемы (Pillow, DejaVuSansMono,
  замена ⟳/⟲ на ↻/↺, потому что глифов нет).
- `scripts/delete-last-fact.mjs` — удалить последний отправленный факт по id из состояния.

Правки в существующих файлах:
- `src/api.js` — `kindForUrl`: адреса `hnrss.org` считаются `rss` (у них нет суффикса `.rss`).
- `src/config.js` — `restartStamp`, `factTimes`, `factEnabled`, `factCatchUpMin`.
- `src/prompts.js` — разделы сводки данными (`SECTIONS`, `SECTION_ORDER`, `sectionList`),
  порядок владельца `[8, 1, 2, 3, 6, 5, 9, 7, 4, 10, 11, 12]`, «воздух» между пунктами,
  ссылка-эмодзи В НАЧАЛЕ пункта, цена и производитель для роботов, `DEFAULT_INTERESTS`
  (Physical AI первой темой, валюты только USD/RUB), `LEGACY_PROFILES` для миграции профиля.
- `src/digest.js` — `sectionKey` для робототехники, `sectionOrderKeys`, `orderSections`
  (детерминированный порядок разделов после веера), экспорт `entrySize`.
- `src/digest-service.js` — `SECTION_FLOORS` и `applySectionFloors`: металлы ≥3 пунктов,
  валюта ≥2, роботы ≥3 (включая китайские заголовки), порядок применяется к готовому тексту.
- `src/text.js` — `repairAnchors` (чинит кривые `<a>`, из-за которых кусок сводки уходил
  без разметки) и учёт `<pre>/<code>` при нарезке сообщений.
- `src/telegram.js` — `sendHtmlIds`, `sendQuiz` (настоящий квиз-опрос Telegram),
  `deleteMessages`, фолбэк HTML → HTML без ссылок → plain.
- `src/sources-pack.js` — 7 источников по Physical AI/робототехнике, `Physical AI` и
  `промпт-инжиниринг` в `INTEREST_TERMS`, миграция прошлых профилей через `LEGACY_PROFILES`.
- `src/main.js` — рубрика в расписании (12:00, окно догона 15 минут), отправка визуала и
  квизов, самоперезапуск, ручная правка прогресса курса файлом `fact-day-override`.

Тесты (все должны пройти): `test/daily-fact.test.js`, `test/visual`-часть в нём,
`test/anchors.test.js`, `test/digest-floors.test.js`, `test/reload.test.js`,
`test/prompts.test.js`, плюс обновлённые `api`, `digest`, `scheduler`, `sources-pack`.

## Чего в репозитории быть не должно

- `restart.request` — рабочая метка самоперезапуска, добавить в `.gitignore`.
- `fact-day-override` — разовый файл правки прогресса курса, тоже в `.gitignore`.

## Проверка после переноса

1. `npm test` — 221 тест, 0 падений.
2. `npm run seed` дважды — второй прогон не создаёт дублей.
3. `deploy/deploy.sh` → на Pi `sudo systemctl restart newsd` →
   `curl -s localhost:8097/api/health` и `sudo systemctl is-active newsd`.
4. Убедиться, что после деплоя на Pi всё ещё есть `src/daily-fact.js` и `src/visual.js`
   (то есть деплой больше не затирает их), и что в 12:00 приходит факт дня.
