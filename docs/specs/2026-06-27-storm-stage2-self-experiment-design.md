# Stage 2: self-experimenting engines in worktrees (дизайн)

- Дата: 2026-06-27
- Статус: дизайн утверждён (модель), готов к writing-plans
- Предшественник: Stage 1 proof-required review (0.9.0,
  `docs/decisions/2026-06-27-proof-required-review.md`)

## Контекст и проблема

Stage 1: движки read-only ревьюят, **описывают** эксперимент тегом
`[NEEDS-EXPERIMENT]`, а гоняет его **оркестратор** в одноразовой копии. Владелец:
полноценное ревью требует, чтобы ревьюер сам изолировал компонент и итеративно
проверил гипотезу — «запустил → не то → переформулировал → снова». Одновыстрельное
«опиши эксперимент» слабее живого копания.

Значит эксперимент надо сдвинуть в **сам движок**. При этом два изначальных
страха оказались театром:
- **деньги/ключи** — решаются **тестовым ключом с бюджет-лимитом на стороне
  провайдера** (его создаст владелец), а не нашим кодом. Не нужны «без сети»,
  budget-счётчик, approve-до-платного, отдельный `prove`-subcommand — всё это
  отпадает.
- **изоляция-ради-безопасности** (Seatbelt/sandbox-exec) — иллюзия: основной
  агент (Claude Code), который вызывает Storm, уже работает в репо с полными
  правами. Движки — его доверенные суб-вызовы, та же модель доверия. Запирать
  вызываемого строже вызывающего бессмысленно. WHY: память
  `feedback_no_security_theater`.

Остаётся ровно два не-security требования:
1. **параллелизм** — 4 движка теперь **пишут** (собирают, коммитят, гоняют
   тесты); в одном каталоге они затрут друг друга и твой рабочий каталог →
   каждому нужна своя рабочая зона. Это механика, не защита.
2. **verify-don't-trust** — движок может **сфабриковать** результат («запустил,
   баг есть», не запустив). Оркестратор перепроверяет заявленный `proven`. Это
   качество ревью (смысл «proof-required»), не защита.

## Решение (одной фразой)

Каждому движку — своя **git worktree** как рабочий корень; внутри движок имеет
**полные права** (write/exec/сеть, тестовый ключ в env) и сам итеративно
экспериментирует, прикладывая proof-artifact; реальный репо нетронут (движок
физически в worktree); оркестратор перепроверяет заявленный `proven`
перепрогоном в свежей worktree. Гейт `config.proof.enabled` сохраняется
(false ⇒ поведение 0.8.0).

Permission-lock из бэклога **переворачивается**: не «read-only», а «полные права
как у основного агента»; изоляцию даёт worktree, а не урезание прав.

## Скоуп первого захода

**Входит:** codex, claude, glm (CLI-движки — получают worktree + полные права
почти даром) + проводка тестового ключа + verify-проход оркестратора + новый
промпт-контракт + рефактор `proof.mjs` под новую модель.

**НЕ входит (следующие заходы, по тому же контракту):**
- **gemini self-exec** — gemini физически не исполняет команд (agentic-loop
  только `read_file`/`list_dir`/`grep`). Чтобы она экспериментировала, нужен
  bounded `execute`-tool в `openrouter-tools.mjs`/`openrouter-runner.mjs` —
  отдельная работа. В этом заходе gemini остаётся read-only ревьюером: её
  находки идут как `unproven` (она не заявит `proven` без exec); оркестратор её
  `[NEEDS-EXPERIMENT]`-описания может перепроверить перепрогоном (как в Stage 1).
- **gemini** в первом заходе работает в worktree-cwd как и все (read-only tools
  и так уважают cwd), просто не пишет/не исполняет.

## Архитектура и поток

```
runAll(task, engines, {cwd, proof}):
  для каждого движка e (параллельно):
    ws = makeEngineWorkspace(cwd, e.id)   // git worktree на HEAD + uncommitted + deps-симлинк
    spawn движок с cwd=ws.dir, полными правами, тестовым ключом в env
    движок: читает + сам экспериментирует в ws.dir + прикладывает [FINDING] run/expects/observed
    ws.cleanup()  // git worktree remove --force; в finally
  -> results

annotateWithProof(results, {repoPath}):   // verify-проход, переписан
  для каждого [FINDING] с run+expects:
    локально-воспроизводимый (не сетевой)?
      да  -> оркестратор перегоняет run в СВЕЖЕЙ worktree(repoPath), predictMatches
              -> proven (подтверждён) | disproven (не воспроизвёл)
      нет -> сетевой/недетерминированный: принять engine-artifact как
              proven-claimed (перепрогон удвоил бы трату и недетерминирован)
```

## Компоненты / изменения по модулям

- **`scripts/lib/workspace.mjs` (новый)** — `makeEngineWorkspace(repoPath, label)
  → { dir, cleanup }`. git-репо → `git worktree add --detach`; перенос
  uncommitted (tracked diff + untracked) в worktree; симлинк `node_modules`
  (если есть) из оригинала. Не-git репо → fallback на `cp -r` копию
  (переиспользовать `sandbox.mjs` makeThrowawayCopy). `cleanup` — идемпотентный
  `git worktree remove --force` + prune (или rm-rf для cp-копии).
- **`scripts/lib/adapters.mjs`** — добавить self-experiment права в команды:
  - codex: `-C <ws>` (рабочий корень) + полный доступ (`-s danger-full-access`
    или `--dangerously-bypass-approvals-and-sandbox` — **спайк** на точный флаг)
    — снимает Seatbelt, даёт write+сеть.
  - claude/glm: `--permission-mode bypassPermissions` (или
    `--dangerously-skip-permissions` — **спайк**), cwd=ws через spawn.
  - gemini: без изменений (read-only tools, cwd уважается).
  - Гейт: эти права добавляются только когда `proof.enabled` и движок в
    self-experiment режиме (не ломать 0.8.0-поведение при proof off).
- **`scripts/lib/fan-out.mjs`** — на каждый движок создать worktree, спавнить с
  `cwd=ws.dir`, гарантировать `ws.cleanup()` в finally (даже на throw/reject).
  Промпт строится per-engine (worktree-путь у каждого свой) или общий с
  относительными путями — **уточнить в плане** (вероятно общий: движок видит
  «.» как свой корень).
- **`scripts/lib/prompt.mjs`** — новый PROOF_CONTRACT для self-experiment (см.
  ниже). Заменяет Stage-1 `[NEEDS-EXPERIMENT]`-контракт когда `proof` truthy.
- **`scripts/lib/proof.mjs`** — переписать `annotateWithProof` под verify
  заявленного (а не «гоняю описанные»). Переиспользовать `predictMatches`,
  `runExperiment`. `classifyCost` перепрофилировать: не default-deny, а детектор
  «локально-перепроверяемо ли» (сетевой ⇒ не перепрогоняем). Новый парсер
  `[FINDING]` (run/expects/observed) рядом с `parseProofFindings`.
- **`scripts/lib/secrets.mjs`** — инжект тестового ключа(ей) в env движка для
  экспериментов (новое поле в `.storm-secrets.json`, напр.
  `experimentEnv: { OPENROUTER_API_KEY: "...", OPENAI_API_KEY: "..." }`).
  Отсутствует ⇒ сетевой эксперимент падает «нет ключа» (не блокер).
- **`scripts/config.json`** — без структурных изменений (proof.enabled остаётся).

## Рабочая зона движка (worktree)

- **git worktree на HEAD**, detached (`git worktree add --detach <tmp> HEAD`) —
  мгновенно (shared objects), полноценный git-репо (движок может собрать/git).
- **uncommitted**: worktree на HEAD не видит незакоммиченное (а его часто и
  ревьюим — регрессия против Stage 1, который копировал рабочее дерево). Поэтому
  после создания перенести: `git -C <repo> diff HEAD | git -C <ws> apply` +
  скопировать untracked (`git ls-files --others --exclude-standard`). **Спайк:**
  подтвердить, что diff|apply надёжно воспроизводит рабочее дерево (бинарники,
  права — приемлемая деградация).
- **node_modules / deps**: симлинк из оригинала (`ln -s <repo>/node_modules
  <ws>/node_modules`), не копируем — чтобы эксперименты с зависимостями работали
  без долгой переустановки. Эксперименты обычно не пишут в node_modules.
- **fallback**: cwd не git-репо ⇒ `cp -r` копия (sandbox.mjs), без worktree.
- **cleanup**: в finally, идемпотентно. Осиротевшие worktree собираются
  `git worktree prune`; полный cleanup при нормальном выходе.

## Промпт-контракт (self-experiment)

Движок инструктируется (когда `proof` on):
- ты в одноразовой рабочей копии (твой `.` — изолированная worktree); делай что
  угодно — пиши, запускай, ставь зависимости, ходи в сеть;
- для каждой находки **сам воспроизведи** её минимальным экспериментом в этой
  копии; не описывай гипотетически — запусти;
- приложи в находке:
  ```
  [FINDING] <title>
  run: <точная команда, которую ты запустил>
  expects: <проверяемое предсказание: exit!=0 | exit==N | stdout contains "X" | stderr contains "X">  (AND-склейка)
  observed: <что реально вышло>
  ```
- помечай `proven` ТОЛЬКО если реально воспроизвёл; если воспроизвести нельзя
  (нет инструмента/недетерминировано) — `[UNPROVEN-CANNOT] <title> — why: <...>`.
- оркестратор перепроверит твой `run`/`expects` в чистой копии — фабрикация
  будет поймана.

`expects`-грамматика — та же, что Stage 1 (`predictMatches`): клаузы
`exit!=0` / `exit==N` / `stdout contains X` / `stderr contains X`, склейка `AND`,
exit-клаузы требуют числового кода (timed-out ⇒ никогда не match).

## Verify-проход (оркестратор)

`annotateWithProof` (переписан):
- для каждого `[FINDING]` с непустыми `run` + `expects`:
  - **локально-воспроизводимый** (`run` не сетевой — детект через
    перепрофилированный `classifyCost`): оркестратор создаёт **свежую** worktree
    из `repoPath` (чистую, без правок движка — иначе движок подсунул бы код, где
    баг «есть»), `runExperiment(run, ws.dir, {timeoutMs, env: experimentEnv})`,
    `predictMatches` → `proven` | `disproven`. Запись artifact (exitCode,
    stdoutTail, stderrTail, matched).
  - **сетевой/недетерминированный**: не перепрогоняем (удвоит трату тестового
    ключа, ответы моделей варьируются). Принять engine-artifact как
    `proven-claimed` с пометкой «verified-by: engine, not orchestrator».
- `[UNPROVEN-CANNOT]` / `[FINDING]` без run|expects → проходят как `unproven`.
- timed-out перепрогон ⇒ никогда не `proven` (guard из Stage 1 сохраняется).
- Вывод: `{ results, verified_experiments, engine_claimed_experiments }`.

## Тестовый ключ

- `.storm-secrets.json` → `experimentEnv: { <ENV_VAR>: <value> }` (gitignored,
  как `glmApiKey`/`openrouterApiKey`).
- `secrets.mjs` инжектит `experimentEnv` в окружение спавна движка (поверх
  inherited env) и в env оркестраторного перепрогона.
- Владелец создаст ключи позже (inference-only, узкий scope, провайдер-лимит).
  Без них сетевой эксперимент падает «нет креда» — движок это видит, помечает
  `unproven-cannot`. Не блокер для локальных экспериментов.

## Обработка ошибок

- worktree create fail (не git / git ошибка) → fallback cp-копия; если и она
  fail → движок запускается в общем cwd с предупреждением (деградация, не краш).
- cleanup fail → лог, prune на следующем запуске; не валим прогон.
- эксперимент-таймаут (оркестраторный перепрогон) → `experimentTimeoutMs`,
  process-group kill (Stage 1 `runExperiment`), `disproven`/`unproven`.
- движок упал/no_result → как в Stage 1 (status пробрасывается, worktree
  чистится).

## Тестирование

- TDD по модулям: `workspace.mjs` (worktree create/uncommitted/deps/cleanup/
  fallback), `prompt.mjs` (новый контракт присутствует при proof on, 0.8.0
  байт-в-байт при off), `proof.mjs` (новый `[FINDING]` парсер, verify локального
  → proven/disproven, сетевой → engine-claimed, timed-out → never proven,
  фабрикация → поймана), `adapters.mjs` (права-флаги при proof on, чистая команда
  при off), `secrets.mjs` (experimentEnv инжект).
- node:test, без runtime-зависимостей.
- Live на самом Storm (`--cwd ~/storm`): движок сам воспроизводит реальный баг в
  своей worktree; оркестратор подтверждает; реальный репо чист; фабрикованная
  находка отлавливается перепрогоном.
- Финальный whole-branch review (opus) + Storm-совет (0.9.0) как adversarial-проход.

## Backward-compat и изменение инварианта

- `proof.enabled=false` ⇒ 0.8.0 поведение байт-в-байт (нет worktree, нет
  прав-флагов, нет verify-прохода). Дефолт остаётся `true`.
- **Изменение инварианта Stage 1:** «cost default-deny / предупредить до
  платного / paid физически не запускается» — **отменяется**. Теперь платное
  запускается свободно в рамках тестового бюджета (провайдер-лимит). Обновить
  `docs/decisions/2026-06-27-proof-required-review.md` (пометка
  superseded-by) + память `project_storm_multi_agent_council`. Новый
  decision-doc Stage 2 при реализации.

## Открытые вопросы / спайки (первыми в плане)

1. Точные флаги полного доступа: codex (`-s danger-full-access` vs
   `--dangerously-bypass-approvals-and-sandbox`), claude
   (`--permission-mode bypassPermissions` vs `--dangerously-skip-permissions`).
2. `git diff HEAD | git apply` в свежую worktree надёжно воспроизводит рабочее
   дерево? (бинарники, права, line-endings).
3. node_modules-симлинк не ломает эксперименты, которые пишут в deps? (низкий
   риск; при проблеме — copy).
4. Промпт per-engine vs общий (worktree-пути различны, но «.» у каждого свой —
   вероятно общий промпт достаточен).
```
