# Storm — heartbeat для молчащих claude/glm (дизайн)

- Дата: 2026-06-25
- Статус: дизайн одобрен, спека на ревью
- Контекст: Storm 0.4.1 (claude + codex + glm), репо ~/storm
- Происхождение: спроектировано самим Storm (совет claude+codex+glm на этот вопрос),
  синтез + эмпирический спайк

## Контекст / проблема

`run-engine` использует inactivity-detect: если движок не выводит ничего в
stdout/stderr дольше `stallMs`, он убивается как `stalled`. Это правильно для
реально зависшего движка, но **claude и glm (один бинарь, glm лишь редиректит
backend) по умолчанию молчат во время reasoning/tool-use** и выдают весь ответ
одним куском в конце. На тяжёлом reasoning молчание превышает любой разумный
`stallMs`.

Вживую (2026-06-25): на дизайн-задаче glm `stalled@150с`, потом `stalled@240с` —
то есть подъём `stallMs` (паллиатив) НЕ решает: glm может молчать сколько угодно.
codex от проблемы не страдает (стримит stderr постоянно).

Прежний дизайн мониторинга (2026-06-22) отложил это как «оверкилл для редкого
кейса». Кейс перестал быть редким после добавления glm.

## Решение

Перевести claude и glm в потоковый формат вывода `--output-format stream-json`.
Тогда они эмитят NDJSON-события throughout (включая reasoning), молчание
исчезает, и **существующий `armStall()` становится настоящим liveness-сигналом**
без нового механизма. codex не трогаем.

### Почему stream-json, а не альтернативы

Совет (claude+codex+glm) ранжировал подходы; синтез:

- **PTY-обёртка — отвергнута.** claude дал ключевой вывод: молчание claude/glm
  **архитектурное** (они не пишут reasoning в stdout), не артефакт TTY-буферизации
  → PTY ничего не изменит. Плюс нарушает zero-dep (node-pty) / платформенно
  фрагильно (script/unbuffer).
- **OS CPU/state polling — отвергнута.** Network-wait trap: здоровый движок,
  ждущий ответа API, жжёт ~0% CPU → flat-CPU дал бы false-kill ровно в том кейсе,
  который мы лечим. Rising CPU доказывает «жив», flat CPU не доказывает ничего.
- **ESTABLISHED-socket check — отвергнута как триггер.** Семантически верный ответ
  на network-trap, но платформенно фрагильный (lsof macOS vs ss//proc Linux),
  односторонний (ESTABLISHED ≠ данные идут). Максимум диагностика.
- **Generous absolute timeout (codex's выбор) — оставляем как FLOOR, не как
  основной сигнал.** Zero-dep, кросс-платформенно, не даёт false-kill до cap, но
  не отличает hung от working — жжёт весь cap на каждом реальном висе. Хорош как
  предохранитель под stream-json, бесполезен соло.
- **stream-json — выбран PRIMARY.** Единственный подход, который *убирает*
  молчание, а не пытается зондировать вокруг него. Zero-dep (встроенный
  `JSON.parse`).

### Эмпирический спайк (обоснование, 2026-06-25)

`claude -p --output-format stream-json --verbose --include-partial-messages` на
reasoning-задаче, claude и glm:

| движок | строк-событий | thinking_delta | text_delta | content_block_delta |
|---|---|---|---|---|
| claude | 63 | 10 | 23 | 34 |
| glm (z.ai) | 513 | 40 | 421 | 461 |

**Оба стримят** — текст И рассуждение (`thinking_delta`) идут потоком во время
работы. glm (z.ai backend) стримит даже агрессивнее claude. Это снимает
единственный серьёзный риск дизайна — «glm/z.ai может не поддержать
partial-messages». Поддерживает.

## Компоненты

### `scripts/lib/adapters.mjs`
Для `claude` и `glm` добавить в args `--output-format stream-json --verbose
--include-partial-messages` (print-режим `-p` сохраняется; промпт по-прежнему
через stdin). Пометить invocation флагом `stream: true`. codex — без изменений.
`buildInvocation` возвращает `stream` наряду с `cmd/args/input/env`.

### `scripts/lib/run-engine.mjs`
- **Liveness не зависит от парсера.** `onActivity` остаётся привязан к сырому
  `'data'`: каждое NDJSON-событие = chunk → `armStall()` сбрасывается. Парсер
  может споткнуться на битой строке — heartbeat обязан жить на сырых байтах.
- **NDJSON-аккумулятор** (только при `stream === true`): копим stdout, бьём по
  `\n`, держим хвостовой неполный фрагмент; каждую полную строку `JSON.parse` в
  try/catch (битую/неизвестную — пропускаем, НИКОГДА не бросаем); на событии
  `{type:"result"}` берём `ev.result` (полный финальный текст ассистента).
- **`on close`:** stream-движок → `extractResult(finalText)`; если `finalText`
  пуст → fallback: собрать `text_delta`-куски → `extractResult` → `salvageTail`
  → последний fallback сырой stdout. non-stream движок (codex) — текущий путь без
  изменений.
- Все таймеры по-прежнему чистятся в `finish` (settled-guard сохранён).

### `scripts/lib/result-parser.mjs`
Без изменений. `extractResult`/`salvageTail` работают на собранном тексте; сборка
живёт в run-engine. (Маркеры `<STORM_RESULT>` едут внутри `ev.result`, поэтому
ищутся в собранном тексте, а не в сыром NDJSON, где они разбиты по token-дельтам.)

### `scripts/config.json`
- `stallMs` 240000 → **60000**: появился настоящий heartbeat, можно быстро ловить
  реальный вис (порог хорошо выше межсобытийных пауз стрима).
- `timeoutMs` 480000 остаётся абсолютным floor (предохранитель).

## Контракт результата

Статусы не меняются (`ok`/`salvaged`/`stalled`/`auth_required`/`timeout`/
`no_result`/`error`). stream-движок при успехе даёт `ok` с тем же `result`, что и
раньше (финальный текст из `ev.result`, прогнанный через `extractResult`).
Оркестратор (`commands/storm.md`) — без изменений.

## Failure modes (риски и митигации)

- **CLI schema/flag drift** (формат событий `stream-json` меняется между версиями):
  парсер толерантен (игнор неизвестных типов, не бросает) + всегда fallback на
  сырой `extractResult`/`salvageTail`. В чисто-json режиме маркеры существуют
  только внутри JSON-строк, поэтому сломанный парсер ломает и извлечение —
  флаги/формат проверяются тестами с зафиксированным фикстур-NDJSON.
- **Wedged tool call** (застрявший MCP-tool не эмитит событий) → выглядит молчащим
  → stall сработает. Обычно верно (застрявший tool = вис); `stallMs` держим выше
  самого медленного легитимного одиночного tool-вызова.
- **Heartbeat ≠ progress** (livelock со стримом keep-alive без реального прогресса)
  → stall не сработает; ловит только абсолютный timeout-floor. Приемлемо.
- **Рост stdout** (token-дельты) → больше памяти/парсинга на стороне родителя;
  ограничено размером ответа, для совета negligible.
- **Orphaned grandchildren на SIGKILL** — pre-existing долг (run-engine line ~51),
  этим дизайном НЕ трогается.

## Тестирование (TDD)

- Новый fixture-режим `stream-json` в `fake-engine.mjs`: эмитит несколько NDJSON
  событий с паузами (heartbeat), затем `{type:"result","result":"...<STORM_RESULT>
  ...</STORM_RESULT>..."}`.
  - liveness: межсобытийные паузы > малого `stallMs` поодиночке, но суммарно
    дольше — НЕ `stalled` (каждое событие ре-армит stall), завершается `ok`.
  - извлечение: `extractResult` достаёт маркер из собранного `ev.result`.
  - битая NDJSON-строка в потоке → пропущена, не роняет (парсер толерантен).
  - нет `result`-события, но есть `text_delta` → fallback-сборка → `ok`/`salvaged`.
- `adapters`: claude/glm несут stream-флаги; codex — нет; `stream` в invocation.
- Существующие тесты (ok/no_result/salvaged/timeout/stall/auth/env) — зелёные.
- Пороги через `opts` override (малые) для скорости/детерминизма.
- run-engine — рискованная зона; финальный whole-diff opus-review.

## Не входит (бэклог)

orphaned-grandchildren process-group kill; live-UI прогресс (показывать
`thinking_delta` юзеру — теперь технически возможно, отдельная фича); per-engine
пороги; OOM-cap буфера. Action-режим — отдельная фаза.
