# Storm delegate mode (дизайн)

- Дата: 2026-07-02
- Статус: дизайн утверждён (по секциям в диалоге), готов к writing-plans
- Предшественники:
  - Stage 2 self-experiment (`docs/decisions/2026-06-27-stage2-self-experiment.md`) — даёт worktree + полные права
  - liveness & visibility v2 (`docs/specs/2026-06-30-storm-liveness-visibility-v2-design.md`) — даёт stall/heartbeat/resolvedModel
  - fix a0dd235 (proof-промпт не светит путь реального репо) — делегат наследует этот инвариант

## Контекст и задача

Storm умеет только `plan` (совет: все движки читают репо и отвечают текстом). Владельцу
нужен второй режим: **Claude Code как заказчик, один движок как полноправный
исполнитель** — пишет код, гоняет тесты, экспериментирует. Кейс: на конкретной задаче
(имплементация, планирование) другой движок объективно сильнее — «Codex обходит на
этой задаче» — и Claude Code должен уметь адресно отдать ему работу, а результат
принять как заказчик: по отчёту и диффу.

Ключевое отличие от `plan`+proof: работа движка **не выбрасывается** (сейчас worktree
чистится, забирается только текст), а возвращается патчем на приёмку.

## Утверждённые решения (диалог 2026-07-02)

| Развилка | Решение |
|---|---|
| Где работает исполнитель | Изолированный git worktree; Claude принимает работу (не правки на месте) |
| Формат результата | Отчёт (STORM_RESULT) + diffstat + **patch-файл**; полный дифф в JSON не попадает никогда |
| Исполнителей на вызов | Один (`delegate <engine> …`); параллель — не сейчас (fan-out готов, включим при нужде) |
| Приёмочная проверка | Опциональный `--verify "<cmd>"` — прогон в worktree ДО передачи патча |
| Упаковка | Новый mode в `storm-companion.mjs`; реюз adapters/workspace/run-engine/secrets/runExperiment |

## CLI-контракт

```
node storm-companion.mjs delegate <engine> "<task>" [--cwd <abs-path>] [--verify "<cmd>"]
```

- `<engine>` — id из `config.engines` (`codex`, `glm`, `claude`). Неизвестный id → exit 2.
- `--cwd` — как в `plan`: абсолютный путь, несуществующий → exit 2 (fail-fast).
- `--verify` — команда приёмочной проверки, гоняется в worktree исполнителя после его
  завершения. Таймаут `config.delegate.verifyTimeoutMs` (дефолт **120000** — прогоны
  тестов дольше 30-секундных proof-экспериментов).
- `delegate` не зависит от `proof.enabled`: полные права в worktree — суть режима.
- **Git-only:** целевой репо обязан быть git-репозиторием. cp-fallback из
  `makeEngineWorkspace` диффить нечем → не-git путь = exit 2 с ясной ошибкой
  (никаких молчаливых деградаций).

## Поток выполнения

1. **Worktree.** `makeEngineWorkspace(cwd, engine)` — HEAD + перенос uncommitted +
   untracked (готовый модуль).
2. **Snapshot-база для диффа.** Сразу после создания: в worktree
   `git add -A && git commit -m "storm-delegate base snapshot"` → `baseRef`
   (с локальной identity `-c user.email/-c user.name`, чтобы не зависеть от
   глобального git config). Иначе патч утащил бы **перенесённые чужие**
   uncommitted-правки владельца вместе с работой движка; снапшот отсекает их —
   патч содержит строго работу исполнителя. (Заказчик применяет патч к рабочей
   копии, где эти правки уже есть.)
3. **Промпт.** Новый `DELEGATE_CONTRACT` в `prompt.mjs`: «ты исполнитель; твоя рабочая
   директория `.` — изолированная копия репо; делай задачу до конца: пиши код, запускай
   тесты, экспериментируй; коммитить не нужно; в конце — отчёт в STORM_RESULT: что
   сделал, что проверил, известные ограничения». Путь реального репо в промпт **не
   попадает** (инвариант a0dd235). Роль (`role`) не подмешивается — у делегата свой
   контракт исполнителя.
4. **Запуск.** `runEngine` с флагами полных прав. Рефактор: в `adapters.mjs` условие
   `cfg.proof` → `cfg.fullRights` (семантика: «полные права», а не «proof-режим»);
   `fan-out` передаёт `fullRights: proof`, delegate — всегда `true`.
   `experimentEnv` из секретов пробрасывается движку, как в proof. Stall v2
   (per-engine `stallMs`), `resolvedModel`, salvage — работают как есть; прогресс
   пишется в stderr тем же heartbeat-форматом (`[storm +Ns] codex: 38ev idle 5s`) —
   heartbeat-хелпер выносится из `fan-out.mjs` и переиспользуется, не дублируется.
5. **Снятие патча.** После завершения движка, в worktree: `git add -A -N` (untracked
   становятся видимы диффу) → `git diff <baseRef> --binary` → **файл**
   `<mkdtemp>/delegate-<engine>.patch`; `git diff <baseRef> --stat` → diffstat.
   Дифф от `baseRef`, а не от текущего HEAD worktree — если движок вопреки просьбе
   накоммитил, его работа всё равно попадает в патч целиком.
6. **Verify (опционально).** `runExperiment(verifyCmd, ws.dir, { timeoutMs, env:
   experimentEnv() })` → `{ run, exitCode, stdoutTail, stderrTail, timedOut }` в выход.
   Verify идёт ПОСЛЕ снятия патча (п.5): если проверка что-то дописывает
   (lock-файлы, артефакты), в патч это не попадает.
7. **Cleanup.** Worktree чистится всегда (`finally`); patch-файл живёт в своём tmp-дире
   и переживает cleanup — он самодостаточен.
8. **Пустой патч — валидный исход.** Задача «спланируй / исследуй» даёт текстовый
   деливерабл в отчёте; `patch: null`.

## JSON-выход

```json
{
  "mode": "delegate",
  "engine": "codex",
  "resolvedModel": "gpt-5.5",
  "task": "…",
  "repoPath": "/abs/target/repo",
  "status": "ok",
  "result": "<отчёт из STORM_RESULT>",
  "patch": {
    "path": "/tmp/storm-delegate-xxxx/delegate-codex.patch",
    "files": 4, "insertions": 120, "deletions": 8,
    "stat": "<git diff --stat, хвост ≤ 2000 симв.>"
  },
  "verify": { "run": "npm test", "exitCode": 0, "stdoutTail": "…", "stderrTail": "…", "timedOut": false }
}
```

- `status` — та же шкала, что в plan (`ok`/`salvaged`/`stalled`/`auth_required`/`timeout`/`no_result`/`error`).
- Контекст-протекция: полного диффа и сырого stdout в JSON нет; отчёт — только
  STORM_RESULT-блок; stat и хвосты verify — с капами.
- При `status != ok|salvaged` патч всё равно снимается, если движок успел что-то
  изменить: частичная работа зарезанного по stall исполнителя может быть ценной.
  `status` в JSON остаётся статусом движка — применять ли такой патч, решает
  заказчик (и по умолчанию не применяет).

## Контракт заказчика (commands/storm.md + SKILL.md)

Новая секция `/storm delegate <engine> <task>`:

1. Запуск: длинные делегации — Bash в background; heartbeat в stderr показывает прогресс.
2. Приёмка: прочитать `result` (отчёт) → `patch.stat` → при необходимости выборочно
   читать patch-файл (Read с limit, не целиком) → `git apply --3way <patch.path>` →
   прогнать свои проверки → при провале `git apply -R` (откат).
3. `verify.exitCode != 0` или `timedOut` — веский повод не применять патч, а вернуть
   задачу исполнителю или доделать самому; сказать пользователю.
4. Никогда не вываливать содержимое патча в ответ целиком; показывать diffstat.
5. Surface `repoPath` и `resolvedModel`, как в plan.

Деплой-шаг вне репо: строчка в CLAUDE.md владельца рядом с codex:rescue — «делегация
исполнителю: `/storm delegate codex|glm "<task>"`» — иначе режим не затриггерится.

## Тесты (node:test, zero-dep, fake-engine)

- fake-engine mode `writes-file`: создаёт/меняет файл в cwd, отвечает маркерами →
  патч содержит файл; **оригинальный репо не тронут**.
- Snapshot-база: uncommitted-правка в исходном репо переносится в worktree, движок
  меняет другой файл → в патче ТОЛЬКО файл движка.
- Движок накоммитил в worktree → патч от `baseRef` всё равно полный.
- `--verify`: pass (exitCode 0), fail (exitCode != 0), timeout → поля в JSON.
- Пустой патч → `patch: null`, `status: ok`.
- Stall во время delegate → `status: stalled`, частичный патч (если есть).
- Не-git `--cwd` → exit 2; неизвестный engine → exit 2.
- Промпт делегата не содержит путь реального репо (инвариант a0dd235).
- `adapters`: `fullRights` даёт те же флаги, что раньше `proof` (рефактор без
  изменения поведения — существующие тесты адаптеров правятся переименованием).

## Не входит (YAGNI)

- Параллельная делегация нескольким движкам и сравнение патчей («action mode»
  из README) — `fan-out` готов, включим отдельным заходом при реальной нужде.
- Авто-apply патча companion'ом; коммиты/ветки в реальном репо от companion.
- Sandbox сверх worktree (решение Stage 2 «без security theater» действует).
- Возврат gemini в пул; делегация gemini (он read-only wrapper без записи).

## Инварианты (не ломаем)

- Контекст-протекция: сырой stdout движка не покидает companion.
- Zero-dep / ESM / node:test; парсим вывод, не exit-коды (кроме fail-fast exit 2).
- Реальный репо не пишется companion'ом ни при каком статусе.
- Liveness v2: работающий (стримящий) исполнитель не убивается; молчащий дольше
  своего `stallMs` — режется, частичная работа снимается патчем.

## Риски (принятые)

- Полные права не запирают движок в worktree механически (как и в proof) — промпт
  не подсказывает путь наружу (a0dd235), остальное — принятый риск Stage 2.
- `git apply --3way` может не лечь, если заказчик далеко уехал от базы параллельной
  работой — конфликт разруливает заказчик (у него есть все инструменты).
- `experimentEnv()` для `--verify` минимален (PATH/HOME/LANG/TMPDIR) — тесты,
  требующие спец-env, в verify не влезут; заказчик прогонит их сам после apply.
