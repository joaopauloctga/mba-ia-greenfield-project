---
kind: task
name: task-jest-runinband-default
status: completed
subproject: nestjs-project
---

# task-jest-runinband-default

## Objective

Fazer o script `npm test` do `nestjs-project` honrar, por padrão, o invariante de execução serial que o próprio `nestjs-project/CLAUDE.md` já declara obrigatório — hoje a garantia depende de quem executa lembrar de passar `--runInBand` na mão.

---

## Problem

`nestjs-project/package.json` define `"test": "jest"`, sem `--runInBand`. O `testRegex` da config Jest é `.*\.(spec|integration-spec)\.ts$`, ou seja, **as suítes unitárias e as de integração entram na mesma execução paralela**, e todas as de integração apontam para o mesmo banco (`db`, database `streamtube` — não há isolamento por worker).

O mecanismo da falha está em `src/test/create-test-data-source.ts`: `cleanAllTables()` roda `DELETE FROM` nas tabelas compartilhadas (`refresh_tokens`, `verification_tokens`, `videos`, `channels`, `users`) e as suítes a chamam em `beforeEach` e `afterAll`. Com workers paralelos, o `beforeEach` de uma suíte apaga as linhas que outra acabou de inserir e ainda vai asserir. Daí o sintoma observado: um `register()` que persiste o usuário e um `userRepository.findOneBy({ id })` logo em seguida devolvendo `null`.

O `nestjs-project/CLAUDE.md` já descreve exatamente esse risco em **Test execution** ("Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently") e instrui a rodar `npm test -- --runInBand`. O gap é que o script não codifica a regra — o caminho default (`npm test`) é o caminho quebrado.

### Evidência medida (2026-08-04, HEAD `012e97c`)

| Invocação | Resultado |
|---|---|
| `npm test` (como está hoje) | ❌ **25 testes falham** / 10 suítes — todas de integração |
| `npx jest --runInBand` | ✅ **201/201** testes, 33/33 suítes — **7,7s** |
| `npx jest --testRegex='.*\.spec\.ts$'` (só unitários, paralelo) | ✅ 103/103 testes, 18/18 suítes — 3,1s |
| `npm run test:integration` (já existe, já tem `--runInBand`) | ✅ 98/98 testes, 15/15 suítes — 5,9s |

`test:e2e` já passa `--runInBand` e não é afetado. As falhas são exclusivamente de orquestração — nenhuma delas indica defeito no código de produção.

---

## Step Implementations

### SI-1 — Adicionar `--runInBand` ao script `test`

**Description:** Alinhar o script default ao invariante documentado, tornando impossível disparar a suíte completa em modo paralelo por esquecimento.

**Technical actions:**

1. Em `nestjs-project/package.json`, alterar `"test": "jest"` para `"test": "jest --runInBand"`.
2. Alterar `"test:cov": "jest --coverage"` para `"jest --coverage --runInBand"` — roda o mesmo conjunto misto e sofre exatamente do mesmo problema.
3. Em `nestjs-project/CLAUDE.md:103`, trocar `docker compose exec nestjs-api npm test -- --runInBand` por `docker compose exec nestjs-api npm test` e registrar na seção **Test execution** que a flag passou a ser default do script — a seção deixa de instruir um workaround manual.
4. Em `README.md:117`, a frase "Testes de integração/e2e rodam com `--runInBand`" é **hoje factualmente falsa** para o `npm test` mostrado em `README.md:112`: só `test:integration`, `test:e2e` e `test:debug` carregam a flag. Após SI-1 ela passa a ser verdadeira e o texto pode permanecer como está — verificar e manter.

**Por que não separar unitários de integração:** a alternativa (`test:unit` paralelo + `test:integration` serial, encadeados) foi medida e sai **mais lenta** — 9,1s contra 7,7s — porque paga dois bootstraps do Jest, e o ganho de paralelismo nos 103 unitários (3,1s) não cobre esse custo. Reavaliar apenas se a suíte unitária crescer a ponto de o serial dominar o tempo total.

**Tests:** _(empty — mudança de tooling; a validação é a própria suíte existente)_

**Dependencies:** none

**Acceptance criteria:**

- `docker compose exec nestjs-api npm test` termina com exit code `0` e reporta **201 passed / 201 total**, **33 suítes**, sem nenhuma flag adicional na linha de comando.
- `docker compose exec nestjs-api npm run test:cov` termina com exit code `0`.
- `docker compose exec nestjs-api npm run test:e2e` continua em **68/68**.
- `grep -n "runInBand" nestjs-project/package.json` passa a casar também nas linhas `test` e `test:cov` (hoje casa só em `test:debug`, `test:integration` e `test:e2e`).
- `grep -rn "npm test -- --runInBand" nestjs-project/ README.md` retorna zero matches.

---

## Out of Scope

- **Isolamento real por worker** (schema Postgres ou database por `JEST_WORKER_ID`, via `globalSetup`). É a correção estrutural — devolveria o paralelismo sem risco de contaminação e escalaria conforme a suíte cresce. Fica registrada como tarefa futura, separada: exige mexer em `create-test-data-source.ts`, no `globalSetup`/`globalTeardown` e na estratégia de migrations por schema, o que é escopo próprio.
- Ajustes de conteúdo em qualquer suíte de teste — nenhuma falha observada decorre de asserção incorreta.
- Alteração do `testRegex` ou introdução de novos sufixos de arquivo de teste (`nestjs-project/CLAUDE.md` → **Jest Configuration** pede que isso seja feito deliberadamente, não como efeito colateral).

---

## Notes

Identificada em 2026-08-04 ao rodar a suíte completa para validar o refazimento do fluxo Git Flow (PRs #5/#6/#7). A condição é anterior a esse trabalho: a árvore do commit validado é byte-idêntica à da `main` pré-rewrite (`c4a46e9`), então nenhuma das falhas foi introduzida por ele.
