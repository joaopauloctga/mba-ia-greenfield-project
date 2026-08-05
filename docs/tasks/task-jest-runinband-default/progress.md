# task-jest-runinband-default — Progress

**Status:** completed
**SIs:** 1/1 completed

### SI-1 — Adicionar `--runInBand` ao script `test`
- **Status:** completed
- **Tests:** no new tests (mudança de tooling — a validação é a suíte existente)
- **Observations:**
  - `nestjs-project/package.json`: `"test": "jest --runInBand"` e `"test:cov": "jest --coverage --runInBand"`.
  - `nestjs-project/CLAUDE.md` → **Test execution** reescrita: deixou de instruir `npm test -- --runInBand` (workaround manual) e passou a afirmar que todo script que roda integração já carrega a flag. Acrescentado o mecanismo concreto da contaminação (`cleanAllTables()` fazendo `DELETE FROM` a partir do `beforeEach` de cada suíte), que antes ficava só implícito em "truncate or seed shared tables concurrently". A tabela de **Container-only commands** ganhou o marcador serial/parallel por script.
  - `test:watch` foi deixado **deliberadamente paralelo** e documentado como exceção: watch mode reexecuta um subconjunto focado de forma interativa, e serializar custaria o loop de feedback. A saída manual (`npm run test:watch -- --runInBand`) está registrada no CLAUDE.md. Fora do escopo do plano original, que listava apenas `test` e `test:cov`.
  - `README.md:117` ("Testes de integração/e2e rodam com `--runInBand`") era factualmente falso para o `npm test` de `README.md:112`; passou a ser verdadeiro com a mudança, então o texto foi verificado e mantido sem edição.
  - Efeito colateral medido: `npm test` passou de ~5,5s (paralelo, falhando) para ~7,7–11,1s (serial, passando). Custo aceito — a alternativa de separar unitários de integração foi medida em 9,1s e descartada no plano.

### Verificação dos Acceptance Criteria

| Critério | Resultado |
|---|---|
| `npm test` exit 0, 201/201, 33 suítes, sem flag extra | ✅ 201 passed / 201 total, 33 suítes, exit 0 |
| `npm run test:cov` exit 0 | ✅ exit 0 |
| `npm run test:e2e` em 68/68 | ✅ 68 passed / 68 total, 4 suítes |
| `grep runInBand package.json` casa em `test` e `test:cov` | ✅ linhas 16 e 18 (além de 19/20/21 preexistentes) |
| `grep -rn "npm test -- --runInBand"` zero matches | ✅ zero |

**Definition of Done:** `npx tsc --noEmit` exit 0; ESLint 0 errors (46 warnings preexistentes, inalterados). Frontend não tocado por esta mudança.
