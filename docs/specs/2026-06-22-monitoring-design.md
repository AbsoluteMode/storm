# Storm — мониторинг действий (дизайн)

- Дата: 2026-06-22
- Статус: дизайн одобрен, спека на ревью
- Контекст: Storm v1.1 (plan-режим), репо ~/storm

## Контекст

v1 использует слепой total-timeout (180с): убивает движок по общему лимиту
независимо от того, работает он или завис. Это маскирует реальные висы под
немой «timeout 180000ms» и при этом может убить медленно думающий движок.
Директива: **мониторить действия, а не наращивать таймауты**.

Важное ограничение объёма: висы/столлы/auth-сбои — **редкие** события, не
частый кейс. Поэтому решение минимальное и прагматичное (graceful обработка
редкого случая), без оверинжиниринга.

## Эмпирические данные (обоснование)

Замер таймингов chunk на средней задаче (2026-06-22):

| движок | heartbeat | поведение |
|---|---|---|
| agy | stdout-стрим | молчит ~8с (reasoning), потом chunks каждые ~200ms |
| codex | **stderr-стрим** | stderr с 0.4с постоянно (паузы до ~16с), stdout — финал одним куском |
| claude | **нет** | молчит везде до ~32с, потом весь ответ stdout одним куском |

Вывод: **heartbeat = любой вывод (stdout ИЛИ stderr)**. agy/codex его дают;
claude не даёт ничего до финала (на сложной задаче — минуты молчания). Единый
порог по молчанию допустим, если он щедрый (не убивает думающий claude).

Решено НЕ делать (оверкилл для редкого кейса): claude через
`--output-format stream-json` (heartbeat ценой парсинга стрима); per-engine
пороги; live-UI в терминале (видимость B). Это кандидаты на будущее.

## Решение

Заменить слепой total-timeout как ОСНОВНОЙ триггер на **inactivity-detect**,
оставив total как дальний backstop, плюс **auth-детект** и **диагностику**.

### 1. Inactivity-detect (основной триггер)
`run-engine` отслеживает `lastActivity` (время последнего chunk stdout ИЛИ
stderr; инициализируется временем старта). Rolling-таймер: на каждый chunk
сбрасывается; если тишина > `stallMs` → `child.kill('SIGKILL')` +
`status: 'stalled'`. Активный движок (agy стримит, codex шлёт stderr) живёт
сколько угодно; реально зависший (нет вывода > stallMs) убивается быстро.

- `stallMs` ~90000 (90с): щедро, чтобы не убить думающий claude на узкой
  задаче (claude молчит до первого вывода; на узкой задаче укладывается), но
  ловит вечный вис/auth.

### 2. Total-timeout — дальний backstop
Сохраняется как предохранитель от вечного медленного стрима. `timeoutMs`
~300000 (300с). НЕ основной триггер. При срабатывании → `status: 'timeout'`.

### 3. Auth-детект по содержимому
На каждый chunk проверяем накопленный stdout+stderr на паттерны
(`sign in`, `sign-in`, `authorize`, `oauth`, `authentication required`,
`log in to`, URL вида `https://…auth…`). Совпадение → `child.kill('SIGKILL')`
+ `status: 'auth_required'` с понятным сообщением, не ждём порога.

### 4. Диагностика
Каждый движок возвращает понятную причину завершения и `lastActivityMs`
(сколько мс назад был последний признак жизни) — вместо немого таймаута.

## Статусы (расширение)

Текущие: `ok`, `no_result`, `salvaged`, `timeout`, `error`.
Добавляются: `stalled` (inactivity), `auth_required` (auth-детект).

Контракт оркестратора (`commands/storm.md`): любой `status != ok` (кроме
`salvaged`, который несёт частичный результат) синтезируется как «движок не
ответил (<status>: <reason>)», совет не падает. Новые статусы вписываются
без изменения этого правила.

## Компоненты

- `scripts/lib/run-engine.mjs` (`runInvocation`) — основная правка:
  - `lastActivity` + обновление на каждый chunk;
  - rolling stall-timer (`stallMs`) → `stalled`;
  - total backstop timer (`timeoutMs`) → `timeout`;
  - auth-scan на каждый chunk → `auth_required`;
  - все таймеры очищаются в `finish` (единый choke-point, settled-guard);
  - `lastActivityMs` в результате.
- `scripts/lib/auth-detect.mjs` (новый) — `detectAuthPrompt(text) -> bool`
  (паттерны, тестируется изолированно).
- `scripts/config.json` — добавить `stallMs`, поднять `timeoutMs` до backstop.
- `commands/storm.md` / `skills/storm-runtime/SKILL.md` — упомянуть новые
  статусы в диагностике (мелкое).

## Надёжность

run-engine — рискованная зона (несколько таймеров + spawn + stdin + settled-
guard). Инварианты v1/v1.1 сохраняются: `let timer` до try (no TDZ), settled-
guard (нет double-resolve), setEncoding utf8, parse-output-not-exit-code,
degraded-not-thrown, prompt-via-stdin/EPIPE-safe, salvage. Все таймеры
(stall + backstop) очищаются в `finish`. Реализацию ревьюит opus.

## Тестирование

- `auth-detect.mjs` — юнит: паттерны срабатывают / не дают ложных на обычном
  тексте.
- `run-engine` через fixture-движки:
  - `slow-stream` (эмитит chunk каждые N мс дольше backstop) → НЕ stalled, не
    убивается inactivity (heartbeat жив), завершается по backstop или close;
  - `silent-hang` (ничего не выводит) → `stalled` после stallMs (тест с малым
    stallMs override);
  - `auth-prompt` (печатает «sign in to continue») → `auth_required` быстро;
  - существующие (ok/no_result/salvaged/timeout/EPIPE/stdin) — зелёные.
- Пороги в тестах задаются через `opts` override (малые), чтобы тесты были
  быстрыми и детерминированными.

## Не входит (бэклог)

claude stream-json heartbeat; live-UI прогресс (видимость B); per-engine
пороги; orphaned-grandchildren process-group kill; OOM-cap буфера. Action-
режим — отдельная фаза.
