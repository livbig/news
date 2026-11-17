# RESEARCH — мост Telegram ↔ сессии pi

Гейт 1. Только факты из первоисточников. Всё, что не подтверждено docs/кодом, помечено
**допущение**. Версии, на которых собран этот документ: pi `1.1.0` (`pi --version`),
Bot API 10.3.

Пути к docs pi (далее сокращаю до `docs/...`):
`~/.pi/agent/install/releases/1.1.0/node_modules/@earendil-works/pi-coding-agent/docs/`

---

## 1. pi-telegram (badlogic, MIT) — что там есть

Прочитан целиком: `index.ts` (1130 строк), `README.md`, `package.json`.
Локальная копия: `/private/tmp/pi-github-repos/runtime-5D5zEE/69b14431.../`.

Это **pi-extension** (`package.json` → `"pi": {"extensions": ["./index.ts"]}`), т.е. код
работает **внутри** одной сессии pi.

| Механизм | Как сделано | Ссылка |
|---|---|---|
| Принадлежность | Бот принадлежит той сессии, где вызван `/telegram-connect` | README «The Telegram bridge is session-local» |
| Приём | Свой long-poll `getUpdates` с `offset`, `timeout: 30`, `allowed_updates: [message, edited_message]`, `deleteWebhook` на старте; `lastUpdateId` в `~/.pi/agent/telegram.json` | index.ts `pollLoop` |
| Стрим | `sendMessageDraft` (черновик) → при ошибке одноразовый фолбэк на `sendMessage` + `editMessageText`, флаг `draftSupport` | index.ts `flushPreview` |
| Троттлинг | `PREVIEW_THROTTLE_MS = 750`, таймер на flush | index.ts `schedulePreviewFlush` |
| Финализация | Драфт эфемерный → финальный текст всегда отдельным `sendMessage` | index.ts `finalizePreview` |
| Длинный ответ | `chunkParagraphs`: по `\n\n`, затем по строкам, затем жёстко по 4096 | index.ts `chunkParagraphs` |
| Очередь | `queuedTelegramTurns[]`, разбор в `agent_start` / `agent_end`; при аборте очередь склеивается в текст следующего промпта | index.ts `preserveQueuedTurnsAsHistory` |
| Stop | текст `stop` / `/stop` → `ctx.abort()` | index.ts `dispatchAuthorizedTelegramMessages` |
| Файлы из pi | tool `telegram_attach` + `sendPhoto`/`sendDocument` | index.ts `registerTool` |
| Файлы в pi | скачивание в `~/.pi/agent/tmp/telegram`, пути в промпте, картинки как `ImageContent` | index.ts `buildTelegramFiles` |
| Пейринг | первый DM-юзер становится `allowedUserId` | index.ts `handleUpdate` |
| Зависимости | ноль: голый `fetch` к Bot API | package.json |

**Чего там нет (ключевой разрыв):** списка сессий, выбора сессии, переключения/продолжения.
Сессия ровно одна — та, внутри которой живёт расширение. Нет и `get_commands` (слэш-команды pi
передавать некуда): понимаются только `stop`, `/compact`, `/status`, `/help`, `/start`.

Вывод: pi-telegram — готовый донор техник для FR4 (стрим, чанки, очередь, stop, attach),
но архитектурно не закрывает FR1–FR2 и FR5. Внутри расширения переключить собственную сессию
нельзя: `session_before_switch` (docs/extensions.md) позволяет switch **отменить**, а не начать.

---

## 2. pi: где живут сессии (FR1, FR2, FR5)

### 2.1 Формат и расположение

`docs/sessions.md` (Sessions and Context):
- «Pi saves a conversation as a session. The active branch of that session supplies conversation
  history for the next model request.»
- «By default, Pi stores sessions under `~/.pi/agent/sessions/`, grouped by working directory.
  Use `--session-dir`, `PI_CODING_AGENT_SESSION_DIR`, or the `sessionDir` setting…»
- «Use `/name` or `--name` to assign a recognizable session name. Run `/session` to verify the
  current session file, ID, message count, token usage, and cost.»

### 2.2 API для списка сессий (источник FR1)

Своей RPC-команды «список сессий» в `docs/rpc-commands.md` **нет**.
API есть в SDK: `dist/core/session-manager.d.ts`:

```ts
export interface SessionInfo {
  path: string; id: string;
  /** Working directory where the session was started. Empty string for old sessions. */
  cwd: string;
  /** User-defined display name from session_info entries. */
  name?: string;
  parentSessionPath?: string;
  created: Date; modified: Date;
  messageCount: number; firstMessage: string; allMessagesText: string;
}
static list(cwd, sessionDir?, onProgress?, signal?): Promise<SessionInfo[]>;
static listAll(onProgress?, signal?): Promise<SessionInfo[]>;
static listAll(sessionDir?, onProgress?, signal?): Promise<SessionInfo[]>;
static findById(cwd, id, sessionDir?): string | undefined;
static open(path, sessionDir?, cwdOverride?): SessionManager;
static continueRecent(cwd, sessionDir?): SessionManager;
```

`examples/sdk/11-sessions.ts` подтверждает рабочий сценарий «List and open specific session»:
`const sessions = await SessionManager.list(process.cwd())` → `info.id`, `info.firstMessage`,
затем `SessionManager.open(sessions[0].path)`.

→ **FR1 закрывается `SessionManager.listAll()`** — API, не ручной парсинг JSONL.
`id`, `name`, `cwd`, `modified` — ровно то, что требует FR1.

### 2.3 Продолжение/переключение сессии (FR2)

`docs/rpc-commands.md` → `switch_session`:

```json
{"type": "switch_session", "sessionPath": "/path/to/session.jsonl"}
```
«Load a different session file. Can be canceled by a `session_before_switch` extension event
handler.» → `{"data": {"cancelled": false}}`.

Рядом: `new_session`, `fork` (по `entryId`), `clone`, `get_entries` (курсор `since` — «an entry id
works as a durable cursor… even across client restarts»), `set_session_name`, `get_state`
(отдаёт `sessionFile`, `sessionId`, `sessionName`, `messageCount`).

`docs/sdk.md` (Session lifecycle) дополняет: `AgentSessionRuntime` даёт `newSession()`,
`switchSession()`, `fork()`, `importFromJsonl()`; «Each operation replaces the active
`AgentSession` and recreates services for the target working directory».

### 2.4 Проверка cwd при переключении (важно для FR2)

`dist/core/agent-session-runtime.js:128-146`:

```js
const sessionManager = SessionManager.open(sessionPath, undefined, options?.cwdOverride);
assertSessionCwdExists(sessionManager, this.cwd);
this.apply(await this.createRuntime({ cwd: sessionManager.getCwd(), ... }));
```

→ cwd берётся **из заголовка самой сессии**, сервисы пересоздаются под неё. Переключение в сессию
из другого каталога работает «из коробки». Если каталог сессии больше не существует —
`assertSessionCwdExists` бросает (нужна человеческая ошибка, см. FR4).

### 2.5 Идентификатор сессии и «своя» учётка состояния (FR5)

В `docs/session-format.md` заголовок сессии: `{"type":"session","version":3,"id":"uuid",...}`.
`get_state` отдаёт `sessionId` и `sessionFile`. Хранить в своём state-файле надёжнее **path**
(его принимает `switch_session`) + `id` для показа.

**Допущение (проверено, см. §8.1):** `listAll()` без аргументов сканирует дефолтный
`~/.pi/agent/sessions/`; для нестандартного `sessionDir` нужен вариант `listAll(sessionDir)`.
Подтверждено чтением `dist/core/session-manager.js:1460-1485`:
`static async listAll(sessionDirOrOnProgress, onProgressOrSignal, signal)` и при отсутствии
строки-каталога берёт `getSessionsDir()` с обходом подкаталогов.

---

## 3. Команды pi (FR3)

### 3.1 Что реально печатает `pi --help` (установленная 1.1.0)

Подкоманды (это отдельные процессы, не сессия):

```
pi install <source> [-l]   pi remove <source> [-l]   pi uninstall <source> [-l]
pi update [source|self|pi] pi list                   pi config [-l]
pi auth <command>          pi mcp <command>          pi <command> --help
```

Флаги, влияющие на сессию: `--provider`, `--model`, `--api-key`, `--system-prompt`,
`--append-system-prompt`, `--mode`, `-p/--print`, `-c/--continue`, `-r/--resume`,
`--session <path|id>`, `--session-id`, `--fork <path|id>`, `--session-dir`, `--no-session`,
`-n/--name`, `--models`, `-nt/--no-tools`, `-nbt`, `-t/--tools`, `-xt/--exclude-tools`,
`--thinking`, `-e/--extension`, `-ne`, `--no-mcp`, `--skill`, `-ns`, `--prompt-template`, `-np`,
`--theme`, `--use-theme`, `--no-themes`, `-nc`, `--export`, `--list-models`, `--verbose`,
`--tui-mode`, `-a/--approve`, `-na`, `--offline`.

**Важно:** `pi list` — это «List installed extensions from settings», а не список сессий.
Команды `pi status` в 1.1.0 нет вообще. Поэтому FR3 трактую так: «команда pi» = флаг CLI и/или
слэш-команда pi, а маппинг в бот — по таблице §3.3.

### 3.2 Слэш-команды pi (docs/slash-commands.md, полный список 1.1.0)

| Группа | Команды |
|---|---|
| Модели/настройки | `/settings` `/model [provider/model]` `/thinking [level]` `/scoped-models` `/login [provider]` `/logout` `/llama` |
| Сессии/контекст | `/new` `/resume` `/name [name]` `/session` `/tree` `/fork` `/clone` `/compact [instructions]` `/import <path>` |
| Экспорт | `/copy` `/export [path]` `/share` `/bug [description]` |
| Среда | `/trust` `/reload` `/hotkeys` `/changelog` `/quit` |
| Ресурсы | команды расширений, промпт-шаблоны, `/skill:name` |

### 3.3 Доступный снаружи набор (RPC) и его границы

`docs/rpc-commands.md` + `docs/json.md` — полный stdin-набор 1.1.0:

`prompt`, `steer`, `follow_up`, `abort`, `clear_queue`, `new_session`, `get_state`,
`get_messages`, `set_model`, `cycle_model`, `get_available_models`, `set_thinking_level`,
`cycle_thinking_level`, `get_available_thinking_levels`, `set_steering_mode`, `set_follow_up_mode`,
`compact`, `set_auto_compaction`, `set_auto_retry`, `abort_retry`, `bash`, `abort_bash`,
`get_session_stats`, `export_html`, `switch_session`, `fork`, `clone`, `get_fork_messages`,
`get_entries`, `get_tree`, `get_last_assistant_text`, `set_session_name`, `get_commands`.

`get_commands` (docs/rpc-commands.md, «Discoverable commands») отдаёт **команды расширений,
промпт-шаблоны и скиллы** (`source: extension | prompt | skill`), запускаются через `prompt` с
префиксом `/`. Явная цитата-ограничение:

> **Note**: Built-in TUI commands (`/settings`, `/hotkeys`, etc.) are not included. They are
> handled only in interactive mode and would not execute if sent via `prompt`.

→ вывод для решения: **встроенные** слэш-команды мост обязан реализовать сам поверх RPC-команд
(`/model`→`set_model`, `/new`→`new_session`, `/resume`→`switch_session`, `/compact`→`compact`,
`/session`→`get_state`+`get_session_stats`, `/name`→`set_session_name`, `/export`→`export_html`,
`/thinking`→`set_thinking_level`, `/fork`→`fork`, `/clone`→`clone`), а **ресурсные** команды
прокидывать как есть через `prompt("/имя аргументы")`.

Не поддержано снаружи (и не будет без отдельной просьбы): `/tree`, `/settings` (TUI),
`/login`/`/logout` (интерактивная авторизация), `/share`, `/bug`, `/trust`, `/reload`,
`/hotkeys`, `/changelog`, `/quit`, `/import`, `/scoped-models`, `/copy`, `--api-key`,
`--system-prompt`, `--append-system-prompt` (задаются при старте процесса).

### 3.4 Готовый клиент протокола

`docs/rpc.md`: «For a subprocess-based TypeScript integration, prefer the exported `RpcClient`,
which starts Pi, correlates responses, exposes typed command methods, and delivers events to
listeners.»

`dist/modes/rpc/rpc-client.d.ts` — экспортируется из корня пакета (`dist/index.d.ts`) и покрывает
FR3 почти целиком: `prompt`, `steer`, `followUp`, `abort`, `clearQueue`, `newSession`,
`getState`, `setModel`, `cycleModel`, `getAvailableModels`, `setThinkingLevel`, `compact`,
`bash`, `getSessionStats`, `exportHtml`, `switchSession`, `fork`, `clone`, `getForkMessages`,
`getEntries`, `getTree`, `getLastAssistantText`, `setSessionName`, `getMessages`, `getCommands`,
`waitForIdle`, `onEvent`, `start`/`stop`. Пример: `examples/rpc-client.ts`.

**Важная деталь, найденная в коде (не в docs).** `RpcClient` по умолчанию спавнит
`node dist/cli.js` — путь **относительный к рабочему каталогу процесса**
(`rpc-client.js:31-42`), т.е. из любого другого проекта он не найдётся. Плюс `exports`-карта
пакета содержит только условие `import`, поэтому `require.resolve(...)` для него падает.
Рабочий способ: `import.meta.resolve('@earendil-works/pi-coding-agent')` → `dirname` → `cli.js`.

**Ещё деталь.** `RpcClient.send()` проставляет свой `id` и ждёт ответа с таймаутом 30 с, поэтому
для ответа на `extension_ui_request` он не годится: ответ пишется строкой JSONL прямо в stdin
дочернего процесса (`docs/rpc-extension-ui.md`).

---

## 4. Событие стрима ответа (FR4)

`docs/json.md` («Reconstruct streaming messages») — источник FR4:

- Кадрирование: строгий JSONL, «Split records only on LF and strip an optional preceding carriage
  return… Node.js `readline` is not suitable for this stream because it also recognizes those
  Unicode separators.»
- События: `agent_start`, `turn_start`, `message_start`, `message_update`, `message_end`,
  `turn_end`, `agent_end` (`messages`, `willRetry`), `agent_settled` (`aborted`).
- Доставка дельт:
  `{"type":"message_update","usage":{...},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Hello "}}`
- Правило склейки: «Use `contentIndex` to identify the content block. Buffer `delta` fields for a
  live display, but replace reconstructed data with the completed content in `text_end`…
  Replace the whole partial message with `message_end.message` when it arrives.»
- Когда работа кончилась: `docs/rpc.md`: «`agent_end` marks the end of one low-level agent run, but
  retries… can still follow. Wait for `agent_settled` when the client needs to know Pi will not
  continue automatically.» И `data.disposition` у ответа `prompt`: `"handled"` — работа не
  начиналась, ждать `agent_settled` нельзя.

→ для бота: **источник строки стрима — `message_update.assistantMessageEvent.text_delta`**,
**граница хода — `agent_settled`**, `text_end`/`message_end` перекрывают буфер (защита от
расхождения).

Стриминг черновика в Telegram (первоисточник: core.telegram.org `sendMessageDraft`):
`chat_id` (Int, обязателен), `draft_id` (Int, обязателен, «must be non-zero. Changes to drafts with
the same identifier are animated»), `message_thread_id`, `text` («0-4096 characters», пустой текст
= плейсхолдер «Thinking…»), `parse_mode`, `entities`, `can_stop`, `keep_on_stop`.
**Черновик эфемерный:** «acts as a temporary 30-second preview - once the output is finalized, you
**must** call `sendMessage` with the complete message to persist it in the user's chat».
Только **private chat**. Отсюда: драфт — не замена `editMessageText`, а дополнение; финальный
текст всегда отдельным `sendMessage` (так же сделано в pi-telegram).

Лимиты (grammY «Scaling Up IV: Flood Limits», со ссылкой на Bot FAQ): ~1 сообщение/сек в чат;
при 429 — «wait for the specified number of seconds» из `retry_after` и повторить; «Do not ignore
429 errors. (This could lead to a ban.)». Точные лимиты не документированы.

---

## 5. Оформление и запуск (нефункциональные)

- `docs/packages.md`: пакет = `package.json` + `pi`-манифест, `pi install <source>`.
  `"pi": {"extensions": ["./src/extension.ts"]}`, ключевое слово `pi-package` для галереи.
  Хост-пакеты (`@earendil-works/pi-*`, `typebox`) идут в `peerDependencies` с `"*"` —
  **для расширений**. Для самостоятельного приложения это ограничение не действует
  (**допущение**: приложение ставит `@earendil-works/pi-coding-agent` в `dependencies`, иначе
  `RpcClient`/`SessionManager` не импортируются).
- `docs/security.md`: «Treat model-generated commands and code as untrusted. Pi can read, change,
  and execute files with the permissions of the account that started it, and it does not ask for
  approval before every tool call.» Проектный `defaultProjectTrust` по умолчанию `"ask"`, а
  печать/RPC/SDK показать запрос доверия не могут: без сохранённого решения защищённые
  ресурсы проекта просто не загрузятся. → бот обязан писать об этом в чат (**допущение**:
  рекомендация `defaultProjectTrust: "always"` для каталогов, которыми управляем из Telegram).
- `docs/environment-variables.md`: процесс-маркеры `AI_AGENT=pi`, `PI_CODING_AGENT=true` ставит
  только CLI/RPC, «They are not set automatically when Pi is embedded through the SDK».
  В bash-tool пробрасываются `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`,
  `PI_REASONING_LEVEL`. Полезно для `/status`.
- `docs/rpc-extension-ui.md` — отдельный подпротокол `extension_ui_request`/`extension_ui_response`
  (диалоги расширений). В 1.1.0 встроенного `ask_question` в `dist/core/tools` **нет** (проверено
  `rg`), но пользовательские расширения (`--approve`/guards и др.) могут спрашивать.
  Критично для моста: в RPC-режиме `ctx.hasUI === true`, диалог **блокирует** ход до ответа или
  таймаута, а `getCommands()` в этом же режиме отдаёт команды расширений — значит отвечать на
  `select`/`confirm`/`input`/`editor` обязательно (`cancelled: true` — штатный ответ).

---

## 6. Итог: что чем закрывается

| FR | Механизм | Источник |
|---|---|---|
| FR1 список сессий | `SessionManager.listAll()` → `SessionInfo{id,name,cwd,modified,messageCount,firstMessage}` | session-manager.d.ts, examples/sdk/11-sessions.ts |
| FR2 продолжить любую | `switch_session{sessionPath}` (RPC) = `RpcClient.switchSession`; cwd берётся из заголовка сессии | rpc-commands.md#switch_session, agent-session-runtime.js |
| FR3 любые команды pi | `get_commands` для ресурсных + 33 RPC-команды для встроенных; список команд/флагов — `pi --help` и slash-commands.md | rpc-commands.md, cli.md |
| FR4 стрим/UX | `message_update/text_delta` → `sendMessageDraft`, фолбэк `editMessageText`, финал `sendMessage`; троттл 750 мс; 429 → `retry_after`; чанки <4096 | json.md, core.telegram.org#sendmessagedraft, grammY flood |
| FR5 маппинг чат↔сессия | свой JSON-файл (`path`+`id` сессии, `lastUpdateId`), восстановление при старте | session-format.md, get_state |

## 7. Допущения и их статус

Проверены запуском (см. §8):

1. `listAll()` без аргументов читает `~/.pi/agent/sessions/` — **подтверждено** (59 сессий).
2\. `sendMessageDraft` может быть недоступен конкретному боту — фолбэк на `editMessageText`
   обязателен. У grammy 1.46 метод **типизирован** (`api.sendMessageDraft(chat_id, draft_id, text, other?)`,
   `node_modules/grammy/out/core/api.d.ts:494`), но доступность метода у бота проверяется только
   живым вызовом — остаётся допущением до прогона в реальном Telegram.
3\. Для standalone-приложения `@earendil-works/pi-coding-agent` держим в `dependencies`:
   ограничение `peerDependencies` из packages.md написано про расширения (`npm install` прошёл,
   `RpcClient` и `SessionManager` импортируются из корня пакета).
4\. Клиенты Telegram поддерживают анимацию драфта; при отсутствии — тот же UX даёт фолбэк.

Отдельно зафиксировано по факту:

5. `getState().sessionFile` — проектируемый путь: **файл сессии создаётся только с первым
   сообщением** (проверено `existsSync` = false сразу после старта и после `new_session`).
   Поэтому в состояние пишем только реально существующие файлы, иначе `switch_session` упал бы
   после рестарта (это подтверждает комментарий в `session-manager.d.ts:248-254`).

## 8. Проверено запуском

### 8.1 Связка с реальным pi (`npm run smoke`)

- CLI найден: `node_modules/@earendil-works/pi-coding-agent/dist/cli.js`.
- `get_state`, `get_available_models` (2 модели), `get_commands` (`/guards`, `/goal`, `/sisyphus`),
  `get_session_stats` — отработали.
- `SessionManager.listAll()` — 59 реальных сессий с id/именем/cwd/messageCount (FR1).
- `switch_session` в сессию из другого каталога (`~/Desktop/ai`) — успешно, `sessionFile`
  переключился (FR2, подтверждает §2.4 про cwd из заголовка сессии).

### 8.2 Автотесты (`npm test`)

100 тестов зелёные (на момент проверки), включая end-to-end прогон моста с настоящим grammY и transformer вместо
Bot API (FR1–FR5 без сети): список сессий и кнопки, открытие по кнопке/номеру/id/имени,
восстановление маппинга из файла состояния, `/status`, `/model`, `/thinking`, `/name`, `/new`,
`/commands`, проброс команд расширений через `prompt`, отказ неизвестной команде, стрим дельт
драфтом, финальный `sendMessage` с HTML, очередь, `/stop`, ошибка провайдера, ответ
`cancelled` на диалог расширения, отказ постороннему пользователю.

### 8.3 Живой запуск с боевым токеном

- `getMe` → `@example_bot (<bot-id>)`; `deleteWebhook` и `setMyCommands` приняты.
- long polling работает: `lastUpdateId` вырос 626004921 → 626004923 (апдейты получены и
  подтверждены), в логе нет `409 … terminated by other getUpdates` — старый pi-telegram не
  опрашивает бота одновременно.
- Данные прежнего моста перенесены из `~/.pi/agent/telegram.json` (`allowedUserId`, offset).
- SIGTERM завершает процесс и гасит поднятые процессы pi (в текущей сборке их было 0:
  процессы создаются лениво, при первом обращении к сессии).

### 8.4 Мультисессии: `pi --mode rpc --session <path>`

Проверено, что процесс можно поднять сразу на нужной сессии, не вызывая `switch_session`:
`createPi({ cwd: <cwd сессии из списка>, args: ['--session', <path>] })` → `get_state` вернул
тот же `sessionId` (`01a12aa6`, 311 сообщений, модель `deepseek/deepseek-flash`) и тот же
рабочий каталог. На этом построен `src/session-pool.js` (см. DECISIONS D12).

### 8.5 Rich Messages и кнопка остановки (Bot API 10.1+/10.3)

Первоисточник — core.telegram.org: `sendRichMessageDraft` требует `chat_id`, `draft_id` и
`rich_message` (`InputRichMessage`, «Exactly one of the fields html, markdown, or blocks must be
used»), опционально `message_thread_id`, `can_stop`, `keep_on_stop`. Это тоже **эфемерный**
черновик: «once the output is finalized, you must call sendRichMessage with the complete message
to persist it in the user's chat». В 10.3 добавили `MessageGenerationStopped` — «A user asked the
bot to stop the generation of a message» (`Update.stopped_message_generation`,
`{chat, message_thread_id?, draft_id}`).

Проверено в коде: grammY 1.46 (`@grammyjs/types` 5.0.0) уже типизирует всё это —
`api.sendRichMessage`/`api.sendRichMessageDraft` (`grammy/out/core/api.d.ts:167,506`),
`bot.on('stopped_message_generation')` (`grammy/out/filter.d.ts:1233`).

Мост берёт markdown из ответа модели **без конвертации** (её больше не нужно писать руками) и
шлёт `can_stop: true` — кнопка «стоп» появляется прямо в клиенте (см. DECISIONS D15).

### 8.6 pi-package (`pi -e ./extensions/pi-telegram-bridge.ts`)

`/telegram-bridge` появляется в `get_commands()` как `source: extension` (39 команд всего в
тестовом каталоге) — расширение собирается и регистрируется pi.

### 8.7 Файлы: Bot API и RPC pi

- `getFile` — «bots can download files of up to 20 MB in size», ссылка
  `https://api.telegram.org/file/bot<token>/<file_path>` (docs#getfile; та же схема уже
  используется для голоса).
- `sendDocument` — «Bots can currently send files of any type of up to 50 MB in size»
  (docs#senddocument). Локальный путь grammY оборачивает в `InputFile`.
- `RpcClient.prompt(message, images?: ImageContent[])` (`dist/modes/rpc/rpc-client.d.ts:66`):
  `ImageContent = {type:"image", data:<base64>, mimeType}` (`@earendil-works/pi-ai/dist/types.d.ts:277`).
  Документы RPC изображениями не принимает — агенту передаётся путь, он читает инструментами.
- Rich HTML (`@grammyjs/types/rich.d.ts`) поддерживает `<table bordered striped compact>`,
  `<caption>`, `<tr><th>/<td>`; обычный `parse_mode: HTML` у `sendMessage` таблиц не знает.
  Поэтому длинные таблицы держим в rich-пути, а классический fallback — только текст/инлайн.

### 8.8 Локальный API ассистента вместо Mini App

Mini App и HTTPS-туннель отключены владельцем; на Pi остаётся локальный HTTP API
(`perimetr/assistant/miniapp-server/server.mjs`, порт `MINIAPP_PORT=8088`) — мост ходит в него
по `http://127.0.0.1:8088` с заголовком `x-service-token: <MINIAPP_SERVICE_TOKEN>`.
Формы ответов (проверено по коду сервера и базе `estimates.db`):

- `/api/projects` — массив объектов `{id, label, type, status, active_estimate_id, estimates}`
  в порядке `updated DESC`, у каждого `estimates[]` с `{id, branch, seq, status, total, created}`
  (`ORDER BY id`). `type` в данных: `склад`, `офис`, `дом`.
- `/api/estimate?id=<id>` — `{id, object:{id,label,type}, client, branch, seq, status, total,
  frozen, created, rows[], meta}`; `client` — имя из CRM или `meta.customer`; строки
  `{section, sku, name, unit, qty, price, sum}`; `meta.discountPct` — скидка за наличные (5).
- `/api/pdf?id=<id>` — байты PDF из `OUTBOX_DIR/smeta-<id>.pdf`, 404 с `{error}` если не собран.
- Ошибки — `{error: "…"}` с кодом 404/500; 403 — сервисный токен не совпал.
