# Storm — proof-required review (дизайн Stage 1)

- Дата: 2026-06-27
- Статус: дизайн одобрен, спека на ревью
- Контекст: Storm 0.8.0 (claude + codex + glm + gemini), репо ~/storm
- Происхождение: спроектировано самим Storm — совет (claude+codex+glm+gemini) прогнан
  на ЭТОМ коде через `--cwd ~/storm` (4/4 ok, `repoPath` verified). Синтез: консенсус
  по протоколу/изоляции/proof/cost-gate; владелец выбрал throwaway-copy и MVP без
  respawn. Сырьё совета — мета-валидация target-cwd (Storm читает свой код и проектирует
  свою же фичу).

## Контекст / проблема

Storm в plan-режиме — read-only ревью: движки читают репо и возвращают находки в
`<STORM_RESULT>`. Находки **никак не доказаны** — движок заявляет баг, но не обязан
его воспроизвести. Владелец вводит политику:

> «Каждый баг, который репортит ревьюер, должен быть ДОКАЗАН, кроме багов, которые
> доказать нельзя или нечем экспериментировать. Ревьюер может ЗАПРОСИТЬ
> инструмент/возможность у оркестратора (Claude Code). Если эксперимент стоит денег
> (например, дёрнуть платный API провайдера), пользователя надо предупредить ДО
> запуска эксперимента.»

Сейчас этого нет: движки read-only, без исполнения; fan-out one-shot (spawn → собрать
один `<STORM_RESULT>`); обратного канала движок→оркестратор нет.

**Предсуществующий риск (нашёл codex на ревью кода):** `codex exec` берёт sandbox из
`~/.codex/config.toml`; при `workspace-write` codex УЖЕ может писать/исполнять в
**реальном** репо под видом read-only plan-ревью. claude подтвердил («codex серый»).
Изоляция исполнения сейчас держится на ambient-конфиге каждого CLI, а не на Storm.

## Решение (Stage 1 MVP)

Доказательство через **структурный маркер + второй проход оркестратора**, исполнение —
в **одноразовой копии** репо, `PROVEN` ставит только оркестратор (verify-don't-trust),
платное — **не запускается** в MVP (только surface).

### Новая инвариант

`experiment-cwd` (одноразовая копия) **≠** `review-cwd` (реальный репо). Чтение —
в реальном репо (как сейчас). **Исполнение — только в копии.** Эксперименты
**bounded** (wall-clock timeout + process-group kill) — в отличие от движков, где
таймауты opt-in OFF ([[no-timeouts-liveness]]): эксперимент может уйти в бесконечный
repro, это другой класс процесса, не регресс liveness.

### Поток

1. **Движки ревьюят** реальный репо (как сейчас), но КАЖДУЮ находку **тегают** под-грамматикой
   внутри `<STORM_RESULT>`:
   ```
   [NEEDS-EXPERIMENT] <заголовок>
     run: <команда, воспроизводящая баг>
     expects: <что в выводе подтверждает: exit!=0 | stdout contains "X" | stderr contains "X">
     cost: free | paid:<provider>
   [UNPROVEN-CANNOT] <заголовок> — why: <гонка / недетерминизм / нет инструмента>
   ```
   Движок **не ставит `PROVEN` сам** — он лишь предлагает эксперимент или признаёт
   недоказуемость. «Уверен по чтению кода» = `UNPROVEN-CANNOT` (исполнением не доказано).

2. **Companion (второй проход)** собирает все `NEEDS-EXPERIMENT` со всех движков и
   **ре-классифицирует cost** (декларации движка не доверяем):
   - **free** → одноразовая копия → `run` → сверка с `expects` → оркестратор ставит
     `PROVEN` (совпало) или `DISPROVEN` (не воспроизвелось).
   - **paid / unknown** → **не запускать**; в `pending_paid_experiments[]`, тег
     `unproven-needs-paid`.

3. **Синтез** (`storm.md`): только `PROVEN` идут как баги; `unproven-*` — отдельной
   секцией; `pending_paid` — «нужен апрув пользователя, чтобы доказать» (исполнение
   платного — Stage 2; в Stage 1 только предупреждаем).

## Компоненты (по файлам)

### `scripts/lib/proof.mjs` (новый; pure + spawn)
- `parseProofFindings(stormResult)` → `[{tag, title, run?, expects?, cost?, why?}]`.
  Толерантный построчный парс (битая строка не роняет; нераспознанное → деградирует,
  не теряется).
- `classifyCost(run, declared)` → `'free' | 'paid' | 'unknown'`. Denylist хостов
  (`openrouter.ai`, `api.openai.com`, `anthropic`, `generativelanguage`,
  `*.amazonaws.com`) + паттерны (`curl`/`wget`/`ssh`, `https?://`, `npm i`/`install`,
  `pip install`, `docker pull`). `declared==='paid'` ⇒ paid; эвристика подозревает
  при declared free ⇒ unknown; иначе free. **`unknown` трактуется как paid**
  (default-deny).
- `predictMatches(expects, {exitCode, stdout, stderr})` → bool. Грамматика `expects`:
  `exit!=0`, `exit==N`, `stdout contains "X"`, `stderr contains "X"` (одиночные или
  через `AND`).
- `runExperiment(run, cwd, {timeoutMs})` → `{exitCode, stdoutTail, stderrTail, durationMs, timedOut}`.
  Исполняет `run` как shell-команду (`/bin/sh -c`) в `cwd` (копия), **detached
  process-group** → kill всей группы по timeout (`process.kill(-pid)`; gemini-вклад).
  Вывод капится (как `MAX_FILE`/`salvageTail`). (argv-режим вместо `sh -c` — харднинг
  Stage 3.)

### `scripts/lib/sandbox.mjs` (новый)
- `makeThrowawayCopy(repoPath)` → `{dir, cleanup}`. `fs.cpSync(repoPath, tmp, {recursive, filter})`;
  `filter` исключает `.git`, `node_modules`, `.storm-secrets.json`, `.env*`, `*.secret`,
  тяжёлые кэши (`.pytest_cache`, `__pycache__`, `.venv`, `dist`, `build`). `cleanup` =
  `fs.rmSync(tmp, {recursive, force})`.
- `experimentEnv()` → минимальный env `{PATH, HOME, LANG, TMPDIR}` — **без** секретов,
  провайдер-ключей, Doppler/ambient. Не наследует `buildEnv` движков.
- **Копия на каждый эксперимент** (свежая) — детерминизм proof (эксперимент не зависит
  от мутаций предыдущих). Trade-off: дороже; единая копия + очистка между = Stage 3.

### `scripts/storm-companion.mjs`
После `runAll`: для каждого результата `parseProofFindings` → собрать `NEEDS-EXPERIMENT`
→ `classifyCost` → free прогнать (`makeThrowawayCopy` + `runExperiment` + `predictMatches`,
затем `cleanup`) и проставить `PROVEN`/`DISPROVEN`; paid/unknown → `pending_paid_experiments[]`.
**Downgrade:** любой `PROVEN`, не подтверждённый артефактом оркестратора, → `UNPROVEN-CANNOT`.
Вывод JSON расширяется: `executed_experiments[]` (прозрачность — что исполнено) и
`pending_paid_experiments[]`.

### `scripts/config.json`
`proof: { enabled: true, experimentTimeoutMs: 30000 }`. `enabled` по умолчанию true
(это и есть фича). При `false` — поведение 0.8.0 (промпт без proof-грамматики).

### `scripts/lib/prompt.mjs`
`reviewer`-роль получает proof-контракт и под-грамматику тегов (только при `proof.enabled`).

### `commands/storm.md` + `skills/storm-runtime/SKILL.md`
Документируют: proof-теги; поля `executed_experiments`/`pending_paid_experiments`;
правило синтеза (только `PROVEN` = баги; unproven — отдельно); обязанность оркестратора
предупредить про `pending_paid` ДО любого исполнения (исполнение платного — Stage 2).

### `scripts/lib/result-parser.mjs`
Без изменений — извлечение `<STORM_RESULT>` то же; proof-слой живёт в `proof.mjs`.

## Контракт результата

JSON companion: к `{ mode, task, repoPath, results }` добавляются `executed_experiments[]`
(`{engine, run, exitCode, matched, tag}`) и `pending_paid_experiments[]`
(`{engine, run, cost, why}`). Статусы движков (`ok`/`salvaged`/…) — без изменений.
При `proof.enabled=false` вывод тождествен 0.8.0 (регресс-гард).

## Безопасность Stage 1 (что гарантируется, что нет)

- **Платное не запускается** → предупреждение «до запуска» — by construction, не дисциплина.
- **Копия не шарит `.git`** → эксперимент не может `push`/переписать refs реального репо.
- **Env без секретов** → даже сетевой вызов из копии не утащит ключи.
- **Bounded** → timeout + process-group kill против зависших/форк-бомб.
- **Принятый риск MVP:** free-эксперимент исполняет repo-код в копии — это **не**
  security-граница (вредоносный `npm`/`postinstall` может писать вне копии или в сеть).
  Митигация MVP: strip secrets + timeout + `executed_experiments` (прозрачность).
  Полная network-off + OS-sandbox (`sandbox-exec`/`unshare`) — Stage 3.
- **Не закрыто в MVP:** review-проход всё ещё читает реальный репо ambient-правами CLI
  (codex-дыра с `workspace-write`). Жёстко закрывает только engine permission-lock —
  Stage 3.

## Failure modes (по убыванию опасности)

1. **Сфабрикованный proof** (движок врёт `PROVEN`) → verify-don't-trust: `PROVEN` только
   при пере-исполнении оркестратором и совпадении с `expects`; иначе downgrade.
2. **Обход cost-gate** (мислейбл платного) → ре-классификация (denylist+паттерны),
   default-deny (`unknown⇒paid`), и структурно: платное в Stage 1 не исполняется вообще.
3. **Мутация реального репо / утечка секретов** → копия без `.git`, env без секретов,
   timeout. (Storm аудирует чужие репо с секретами — ставки высоки.)
4. **Зависший/прожорливый эксперимент** → bounded timeout + `process.kill(-pid)`.
5. **Prompt-injection через free-эксперимент** (repo-код с сетью) → strip secrets +
   timeout + surface; network-off — Stage 3.
6. **Эрозия context-protection** (раздутый артефакт тащит chatter) → границу пересекает
   только нормализованный, капнутый оркестратором артефакт (лимиты как `MAX_FILE`).
7. **Malformed proof-грамматика** → толерантный парс; нераспознанное → `unproven`, не
   теряется.
8. **Orphaned-копии при kill оркестратора** → cleanup на `SIGINT`/`exit` (gemini-вклад).

## Тестирование (TDD)

- `proof.mjs`: `parseProofFindings` (теги, под-грамматика run/expects/cost, толерантность
  к битому); `classifyCost` (free/paid/unknown, denylist хостов, default-deny unknown,
  declared-paid побеждает); `predictMatches` (exit!=0 / exit==N / contains / AND);
  `runExperiment` (fake-repo в tmp: успех→exit+capture; бесконечный→timeout+kill).
- `sandbox.mjs`: `makeThrowawayCopy` исключает `.git`/`node_modules`/секреты; `cleanup`
  удаляет; `experimentEnv` без секретов.
- companion (integration-lite): движок эмитит free `NEEDS-EXPERIMENT` → оркестратор
  аннотирует `PROVEN`/`DISPROVEN`; paid → `pending`, не исполнен; неподтверждённый
  `PROVEN` → downgrade; `proof.enabled=false` → вывод как 0.8.0.

## Не входит (Stage 2 / Stage 3)

- **Stage 2:** исполнение платных экспериментов через `storm-companion prove
  --approved-experiment <id>` (hard-gate в коде) + опциональный respawn движка вторым
  проходом с артефактами (финальный narrative).
- **Stage 3:** OS-sandbox (`sandbox-exec`/`unshare`) + network-off для экспериментов;
  **engine permission-lock** (`claude --allowedTools`, codex sandbox-флаги) — жёстко
  закрывает ambient-дыру; CLI Bash self-exec в приватной копии (черновики repro);
  Gemini `run_command` (паритет self-exec); argv-режим исполнения вместо `sh -c`
  (анти-инъекция, codex-вклад); дедуп одинаковых экспериментов между движками; единая
  копия + git-clean между экспериментами; cost $-оценка; flaky multi-run
  (`proven-flaky`).
- Интерактивный back-channel движок↔оркестратор — **отвергнут** (one-shot CLI), не отложен.
- `action`-режим / любая запись в реальный репо — вне скоупа.
