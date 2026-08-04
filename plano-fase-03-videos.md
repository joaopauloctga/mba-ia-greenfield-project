# Fase 03 — Upload e Processamento de Vídeos: pipeline de planejamento

## Context

O desafio pede a continuidade do StreamTube com a **Fase 03 — Upload e Processamento de Vídeos**, conduzida pelo workflow de IA do repositório. As Fases 01 e 02 estão fechadas (backend + frontend) e **não existe nada de Fase 03**: sem `docs/decisions/technical-decisions-phase-03-videos.md`, sem `docs/phases/phase-03-videos/`, sem `src/videos/`, e o `compose.yaml` tem só `nestjs-api`, `db` e `mailpit`.

Como a Fase 03 é um desafio de engenharia (arquivo de 10GB, fila, worker FFmpeg, streaming) e não um CRUD, o enunciado é explícito: **o plano é o que segura a implementação**. Por isso esta sessão vai **do research até o plano executável**, deixando `validation.md` em `clean` e o `phase-03-videos.md` completo — a implementação fica para a sessão seguinte.

Decisões já confirmadas com o usuário:
- **Escopo desta sessão:** pipeline até o plano (para antes de implementar).
- **Git Flow:** criar `dev` a partir de `main`, depois `feature/phase-03-videos` a partir de `dev`.
- **Fila:** o research pesquisa as opções e traz trade-offs + recomendação para aprovação (não pré-decidir).
- **context7:** adicionar ao `.mcp.json`.

---

## Passo 0 — Pré-requisitos (bloqueiam o pipeline)

### 0.1 `context7` no `.mcp.json` ⚠️ exige reinício

`.mcp.json` hoje só tem o servidor `postgres`. `CLAUDE.md` e os critérios de aceite exigem consulta de doc de lib via **context7**, e o `plan-resolve` usa `mcp__context7__resolve-library-id` / `query-docs` para gerar o `library-refs.md`.

Adicionar ao `.mcp.json` (preservando `postgres`):

```json
"context7": { "type": "http", "url": "https://mcp.context7.com/mcp" }
```

Mudança em `.mcp.json` **só entra em vigor após reiniciar o Claude Code** e aprovar o servidor. Como o `research` também depende de context7, o reinício acontece **antes** de qualquer estágio. Este arquivo de plano é o handoff da nova sessão.

### 0.2 Branches (Git Flow)

```bash
git checkout -b dev main          # dev não existe hoje
git checkout -b feature/phase-03-videos dev
```

Trabalhar sempre em `feature/phase-03-videos`. Relevante: o preflight do `/implement` **recusa rodar em `main` ou `dev`**, então a branch precisa existir antes da fase de implementação.

Observação a reportar: `main` local está 1 commit à frente de `origin/main` (`fix: local setup.`) — commit direto em `main` feito antes desta sessão. Não vou mexer nisso; só evito repetir.

---

## Convenção de nomes (guardrail)

O repositório usa, na prática, `slug = phase-NN-topico`:

| Artefato | Caminho |
|---|---|
| Decisões | `docs/decisions/technical-decisions-phase-03-videos.md` |
| Pasta da fase | `docs/phases/phase-03-videos/` |
| Frontmatter | `kind: phase`, `name: phase-03-videos` |
| Plano | `docs/phases/phase-03-videos/phase-03-videos.md` |

Precedente: `technical-decisions-phase-02-auth.md` + `docs/phases/phase-02-auth/` + `name: phase-02-auth`.

Dois desvios entre o texto das skills e a prática do repo — **seguir a prática do repo**, que é o que o enunciado exige:
1. `research/SKILL.md` diz "no phase number in the filename"; o repo usa `phase-NN-` no slug.
2. `plan-pipeline/SKILL.md` descreve a pasta como `docs/phases/phase-NN-{slug}/`; aplicado literalmente com `slug = phase-03-videos` geraria `docs/phases/phase-3-phase-03-videos/`. **Fixar explicitamente os caminhos da tabela em cada estágio.**

Fase 03 é **monolítica** (uma única slice cobrindo os 9 bullets, todos backend) → **omitir `covers_capabilities`** no frontmatter, o que suprime o advisory `MC-cross-N`.

---

## Etapa 1 — `/research phase 03` → `technical-decisions-phase-03-videos.md`

Frontmatter: `scope_type: phase`, `related_phases: [3]`, `status: pending`, `date: 2026-07-25`, `scope_description`.

Cada TD precisa de `**Scope:**` (obrigatório — o `plan-build` filtra as subseções de Tech Specs por ele), `**Capability:**` citando **verbatim** um bullet da Fase 03 do `docs/project-plan.md`, 2–4 opções com Pros/Cons, `**Recommendation:**` e `**Decision:** _[pending]_`.

TDs a pesquisar (o `Scope` importa: `Repo-wide` **não renderiza** em nenhuma subseção de Tech Specs, então o que precisa aparecer em Data Model / API Contracts / Events deve ser `Backend` ou `Cross-layer`):

| # | Tópico | Scope previsto | Opções a levantar |
|---|---|---|---|
| 1 | **Tecnologia de fila** (o "TBD" do C4 — decisão principal) | Backend | BullMQ+Redis (`@nestjs/bullmq`) · RabbitMQ (`amqplib`/`@nestjs/microservices`) · pg-boss (sem infra nova) |
| 2 | **Estratégia de upload de 10GB** | Cross-layer | multipart pré-assinado S3 (create → part URLs → complete) · tus resumable · PUT pré-assinado único · proxy pela API (rejeitar) |
| 3 | **Organização de buckets/chaves no storage** (MinIO/S3 é dado, o *como* não) | Backend | bucket único com prefixos vs buckets separados vídeo/thumbnail; layout de key |
| 4 | **Topologia do worker** | Backend | container próprio com o mesmo código (Nest standalone) vs app separado; imagem com FFmpeg |
| 5 | **Extração de metadados + thumbnail** | Backend | `ffprobe`/`ffmpeg` via `child_process` vs `fluent-ffmpeg`; escolha do frame |
| 6 | **Estratégia de URL única** | Backend | slug curto (`nanoid`) com unique index · UUID · hashid — o `project-plan.md` §4 pede "URLs únicas curtas" |
| 7 | **Estratégia de streaming e download** | Cross-layer | GET pré-assinado direto ao storage (o C4 já desenha `frontend → storage "Streams"`) vs proxy pela API com Range/206 |
| 8 | **Ciclo de status + tratamento de falha** | Backend | máquina de estados `draft → processing → ready\|failed`; retry/idempotência do job |

Restrição factual a levantar no TD-2 (limite documentado do S3, não decisão inventada): **PUT único no S3 tem teto de 5 GiB**, logo 10GB obriga multipart ou tus. Isso mata a opção de PUT pré-assinado simples.

Ao fim: apresentar as recomendações e coletar as decisões do usuário (o `_[pending]_` é preenchido pelo `plan-resolve`, não aqui).

## Etapa 2 — `/plan-context phase-03-videos` → `context.md`

Despacha em paralelo `plan-reader`, `decisions-reader`, `decisions-detail-reader`, `decisions-correlator`, `phases-reader`. **Não** despacha `inventory-digest-reader`: a Fase 03 não tem nenhum bullet de tela → `ui_in_scope: false`, sem `## UI Inventory` (igual ao `phase-02-auth/context.md`).

Seções na ordem obrigatória: `## Scope` → `## Decisions Index` → `## Capability Coverage` → `## Decisions Detail` → `## Inherited Decisions Detail` → `## Inherited Conventions` → `## Inherited Deferred Capabilities` → `## Non-UI / Deferred Capabilities` → `## Testing Requirements`.

No `## Scope`, preencher os campos que o `project-plan.md` não tem (o formato dele só traz `Depende de:` + bullets + Entregáveis) seguindo o precedente da Fase 02: **Out of scope** (edição de vídeo, categorias, painel do canal, player — Fases 04/05), **Affected subprojects:** `nestjs-project/`, **Deferred subprojects:** `next-frontend/` (interface de vídeo fora do escopo desta fase, conforme o enunciado).

## Etapa 3 — `/plan-validate phase-03-videos` → `validation.md`

Lê **só** o `context.md`. 8 checks em phase mode. Fecha com `status: clean|dirty` + `issue_count`.

## Etapa 4 — `/plan-resolve phase-03-videos` → decisões + `library-refs.md`

Preenche `**Decision:**` de cada TD via `AskUserQuestion` em duas passadas (coletar tudo → aplicar edits), patcheia `context.md` e marca as issues como `resolved`. Busca doc via context7 e escreve `docs/phases/phase-03-videos/library-refs.md` com as libs novas fixadas (fila, cliente S3, ffmpeg, gerador de id) — frontmatter `libs: { version, context7_id, fetched_at }` + `sources_mtime`.

## Etapa 5 — `/plan-validate phase-03-videos` (re-run) → `clean`

Iterar 4 ↔ 5 até `status: clean`. É gate duro: o `plan-build` aborta com `status != clean`.

## Etapa 6 — `/plan-build phase-03-videos` → `phase-03-videos.md`

Roda em duas fases com pausa entre elas (Phase A escreve scaffold + Tech Specs; Phase B escreve os SIs, Dependency Map e Deliverables). Sem sub-agents (proibido nesta skill). Frontmatter emite `test_specs_aware: true`.

Tech Specs na ordem canônica — **`### Events/Messages` é obrigatória aqui** por causa da fila (template em `.claude/skills/plan-build/templates/tech-specs/events-messages.md`, com Payload/Producer/Consumer/Trigger/Delivery semantics):

`### Data Model` → `### API Contracts` (+ `#### Validation Rules`) → `### Authorization Matrix` → `### Error Catalog` → `### Events/Messages`

Fatiamento esperado dos SIs (`SI-03.x`, ≤5 ações e ≤10 ACs cada — o número final sai do plan-build):

infra no Compose (MinIO + fila + worker) e config/env → entidade `Video` + migration → serviço de storage (multipart pré-assinado) → módulo de fila (produtor) → endpoints de início/conclusão de upload com pré-cadastro em rascunho → worker consumidor (ffprobe + thumbnail + transição de status) → endpoint de streaming (Range/206) → endpoint de download → tratamento de falha/retry.

Deliverables devem incluir as linhas de suíte completa no formato do repo (`docker compose exec nestjs-api npm test -- --runInBand`, `npm run test:e2e`, `npx tsc --noEmit`, `npm run build`).

## Etapa 7 — `/plan-test-specs phase-03-videos` → `nestjs-project/specs/*.plan.md`

Dispara porque a fase tem SIs de controller-wiring (com `**Route:**`) e o TD de upload é `Cross-layer`. Reescreve `**Test Specs:** _pending_` → `see \`<path>\`` no plano.

---

## Arquivos criados/alterados nesta sessão

**Novos:** `docs/decisions/technical-decisions-phase-03-videos.md` · `docs/phases/phase-03-videos/{context,validation,library-refs,phase-03-videos}.md` · `nestjs-project/specs/*.plan.md`

**Alterados:** `.mcp.json` (+ context7)

**Não tocar nesta sessão:** `src/`, `compose.yaml`, migrations, `CLAUDE.md`, o diagrama C4 (a troca do `Message Queue "TBD"` pela tecnologia escolhida e a seção de vídeos no `CLAUDE.md` são entregáveis da fase de **implementação**, para não documentar código que ainda não existe — o critério de aceite é justamente coerência com o código).

---

## Atritos conhecidos do pipeline (não são bugs meus; tratar em runtime)

1. **`library-refs.md` — nível de heading.** O repo escreve `## {lib}` (e o `/implement` faz grep de `^## {library}`), mas o `plan-build` B2.5 faz grep de `^### {lib-name}` para checar cobertura. Vou seguir o precedente do repo (`##`) e, se o B2.5 acusar lib não coberta, conferir manualmente em vez de aceitar o falso negativo.
2. **Divergência de formato entre a Fase 02 e o template atual.** O `phase-02-auth.md` é legado: tabela de testes `| File | Layer | Verifies |` e ações com `-`. O template atual do `plan-build` manda `| Artifact | Layer | Test file |` e ações numeradas. O plano novo sai no **formato atual** (igual ao `phase-02-auth-frontend.md`); a estrutura de seções que o enunciado cobra é a mesma.
3. **`docs/rules/{plan-validate,plan-build}/` não existe** → os passos de custom rules são no-op. Esperado, não é falha.
4. **`Scope: Repo-wide` não renderiza em Tech Specs.** Se o TD de infra do Compose virar `Repo-wide`, o que precisa aparecer em Data Model/Events tem de estar em TD `Backend`. Vou checar isso ao classificar os TDs.

---

## Verificação (fim da sessão)

1. `docs/decisions/technical-decisions-phase-03-videos.md` existe, `status: decided`, todo TD com `Scope` + `Capability` verbatim + `Decision` preenchida (nenhum `_[pending]_`).
2. `docs/phases/phase-03-videos/` tem `context.md`, `validation.md`, `library-refs.md`, `phase-03-videos.md`.
3. `grep -n '^status:' docs/phases/phase-03-videos/validation.md` → `clean`; `issue_count: 0`.
4. `grep -cE '^### SI-03\.' docs/phases/phase-03-videos/phase-03-videos.md` > 0 e `grep -n '^### ' ...` mostra `Data Model`, `API Contracts`, `Authorization Matrix`, `Error Catalog`, **`Events/Messages`**.
5. `grep -n '^## ' ...` mostra `Objective`, `Step Implementations`, `Technical Specifications`, `Dependency Map`, `Deliverables`; nenhum sentinel `<!-- ... -->` remanescente.
6. Cada capability da Fase 03 tem cobertura no `## Capability Coverage` do `context.md`.
7. `git branch --show-current` → `feature/phase-03-videos`; `git log origin/main..HEAD --oneline` sem commits em `main`.
8. Revisão crítica minha, item a item, contra os Critérios de Aceite da seção "Decisões e planejamento" do enunciado.

Sem `npm test` / `tsc` / `lint` nesta sessão — a Definition of Done técnica só se aplica quando houver código (sessão de implementação).
