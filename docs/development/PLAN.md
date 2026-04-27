# Plano — cobertura completa SIA-PA no dataviz site

> **Objetivo**: 2008–2026 × 27 UFs × 12 meses publicados em CloudFront
> (`dfdu08vi8wsus.cloudfront.net`, origem S3
> `precisa-saude-datasus-brasil`). Total esperado: ~7.452 partições.

## Status atual (2026-04-27)

| Anos      | Partições / Esperadas | UFs   | Estado                                |
| --------- | --------------------- | ----- | ------------------------------------- |
| 2008–2013 | 324/324 cada          | 27/27 | ✅ completo                           |
| 2014      | 288/324               | 24/27 | 🟡 falta SP/RJ/MG                     |
| 2015      | 0/324                 | 0/27  | ⏳ na runner workspace, falta sync S3 |
| 2016–2019 | 0/324 cada            | 0/27  | ⏳ não arquivado                      |
| 2020      | 312/324               | 26/27 | 🟡 falta 1 UF                         |
| 2021      | 288/324               | 24/27 | 🟡 falta SP/RJ/MG                     |
| 2022–2023 | 0/324 cada            | 0/27  | ⏳ não arquivado                      |
| 2024      | 12/324                | 1/27  | 🟡 só 1 UF                            |
| 2025–2026 | 0                     | 0     | ⏳ depende de releases upstream       |

**Total**: ~3.192 / ~7.452 (~43%).

## Steps

### 1. Fix do commitlint no `backfill.yml` (extender PR #15)

`backfill.yml:124` usa `state(sia-pa):` — `state` não é type válido de
Conventional Commits. Sem isso, todo run de backfill falha no último
step `Commit state/sia-pa.json` (S3 sync já tem rodado, mas state file
não atualiza).

- Diff já staged em `fix/refresh-commit-scope`: troca pra
  `chore(data): backfill sia-pa …`.
- Aprovar mensagem → push → PR #15 atualizado → merge.

### 2. Re-trigger backfill 2014–2015 (sync do que já foi arquivado)

Os parquets de 2014 SP/RJ/MG e 2015 inteiro estão na runner workspace
do desktop (`~/actions-runner-datasus-parquet/_work/.../build/sia-pa`).
O run anterior foi cancelado durante o S3 sync.

```bash
gh workflow run backfill.yml \
  -F ufs=ALL -F years=2014-2015 \
  -F throttleMs=100 -F yearPauseMs=0 \
  -F markProcessed=true -F invalidateCloudFront=true
```

Idempotente — Archive pula parquets que já existem; só sobe pro S3 e
invalida CloudFront. Estimativa: ~30min.

**Saída esperada**: 2014 = 27/27, 2015 = 27/27 (24 UFs cacheados +
SP/RJ/MG split files via runner WS).

### 3. Verificar cobertura 2008–2015

```bash
~/datasus-status.sh coverage
```

Deve mostrar 2008–2015 todos com Pub=27 ✅.

### 4. Backfill 2016–2018

```bash
gh workflow run backfill.yml -F ufs=ALL -F years=2016-2018 ...
```

Estimativa: ~10–15h (3 anos × split files SP novos pra 2016+, MG/RJ
canônicos até 2020).

### 5. Backfill 2019 e enriquecimento 2020–2021

```bash
gh workflow run backfill.yml -F ufs=ALL -F years=2019-2021 ...
```

2020/2021 já têm os 24 UFs canônicos publicados — idempotência cuida
disso, só fetcha e sobe SP/RJ/MG (RJ/MG ainda canônicos pra 2020;
começam a splitar em 2021).

### 6. Backfill 2022–2024

```bash
gh workflow run backfill.yml -F ufs=ALL -F years=2022-2024 ...
```

Anos mais recentes — RJ/MG já em modo split file (desde 2021), além
do SP. 2024 só tem 1 UF publicado hoje, precisa de quase tudo.

### 7. Backfill 2025–2026

Antes de rodar, validar disponibilidade upstream com
`pnpm detect-new --dry-run` ou checar manualmente em
`ftp.datasus.gov.br/dissemin/publicos/SIASUS/200801_/Dados/`.
Última competência detectada hoje: `2026-02`. Rodar só anos com
DBCs reais.

## Critério de done

`~/datasus-status.sh coverage` mostra Pub=27 ✅ pra todos os anos com
DBCs disponíveis no FTP. Anos sem upstream ficam documentados em
`state/sia-pa.json` ou no manifest.

## Riscos & notas

- **Cada run de backfill ocupa o runner self-hosted** (`rafael-desktop-archive`).
  Outros deploys que precisam desse label ficam na fila.
- **Partições missing por gap upstream** (FTP 550 em mês específico)
  são esperadas e logadas em `/tmp/archive-skipped.log`. Não tentar
  re-fetchar — abrir issue se for sistemático.
- **PR #15 deve fazer merge antes de qualquer re-run** pra que o
  state commit não falhe.
