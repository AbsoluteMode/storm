# proof-required review: throwaway-copy + verify-don't-trust (решение)

- Дата: 2026-06-27
- Статус: реализовано Stage 1, Storm 0.9.0

## Контекст

Storm plan-режим — read-only ревью; находки НЕ доказаны (движок заявляет баг, но не
воспроизводит). Владелец ввёл политику: «каждый баг доказан, кроме недоказуемых или тех,
где нет инструмента; инструмент ревьюер запрашивает у оркестратора (Claude Code); платный
эксперимент — предупредить пользователя ДО запуска». Сама фича спроектирована советом
Storm (claude+codex+glm+gemini, 4/4, прочитавшими код Storm через `--cwd ~/storm`).

## Решение

Структурный маркер (`[NEEDS-EXPERIMENT]` с run/expects/cost, `[UNPROVEN-CANNOT]`) +
второй проход оркестратора. FREE-эксперименты исполняются в **одноразовой копии** репо;
`PROVEN` ставит ТОЛЬКО оркестратор по своему захваченному артефакту; paid/unknown НЕ
запускаются (только surface в `pending_paid_experiments`). Stage 1, гейт
`config.proof.enabled` (default true; false = поведение 0.8.0 байт-в-байт).

## Почему

- **verify-don't-trust.** Движок не может сам объявить `proven` — его claim
  (`[PROVEN]`) downgrade'ится в `unproven-cannot`; `proven` только при совпадении
  предсказания с орк-captured выводом. Иначе фабрикация доказательств убивает смысл
  фичи. **Timed-out эксперимент НИКОГДА не proven** (двойной guard — этот баг нашёл сам
  live-прогон: `null !== 0` ложно матчил `exit!=0`).
- **throwaway-copy, а не git worktree.** Копия ловит **незакоммиченные** правки (их чаще
  и ревьюим) и НЕ шарит `.git` object-store → эксперимент физически не может
  `push`/переписать refs реального репо. Совет: 3 движка за worktree, codex за copy —
  взяли copy (аргумент сильнее голосов).
- **cost default-deny.** Декларации движка не доверяем — оркестратор ре-классифицирует
  (denylist хостов/паттернов), `unknown⇒paid`, и платное в Stage 1 физически не
  запускается → предупреждение «до запуска» гарантировано конструкцией, не дисциплиной.

## Что протестировали

- TDD по модулям (parse / cost / predict / run / sandbox / annotate), 26/26 proof-тестов.
- Live на самом Storm (`--cwd ~/storm`): 3 движка доказали реальные баги в копии, реальный
  репо остался чист. Прогон НАШЁЛ 2 бага в себе — timed-out false-proven (CRITICAL) и
  `.envrc` не в Gemini-sandbox blocklist — оба починены.
- opus whole-branch review: 4 инварианта (verify-don't-trust / cost default-deny /
  изоляция / backward-compat) подтверждены ЭМПИРИЧЕСКИ (env-leak, cost-bypass,
  fabricated-proof, timed-out-with-output — все отбиты). Ready to merge.

## Отвергли

- **Интерактивный back-channel** движок↔оркестратор — one-shot CLI его не тянут (совет
  единогласно).
- **Self-execution движком** — делает требование «предупредить до платного»
  неисполнимым; verify-don't-trust нейтрализует выгоду само-исполнения.
- **git worktree изоляция** — не видит uncommitted без доп. логики, шарит object-store
  (риск push/refs) — codex-аргумент.
- **Доверять cost-декларации движка** — обходимо; ре-классификация + default-deny.
- **Запуск платных экспериментов в Stage 1** — отложен (Stage 2: approve→`prove`).
- **SIGINT hard-cleanup копий** — отложен в Stage 3 (копии в OS `tmpdir` без секретов
  собираются ОС; нормальный путь чистит в `finally`).

хвост: ветка main, коммиты `87d0f40..`, Storm 0.9.0.
