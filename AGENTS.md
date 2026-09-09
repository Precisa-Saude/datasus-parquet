# Specific instructions — datasus-parquet

> This file holds ONLY the rules specific to this repository. The
> shared rules across the precisa-saude ecosystem (tone, git, hooks,
> reviews, worktrees, source verification, test coverage, code
> conventions) live in `@precisa-saude/agent-instructions`.
>
> **Read the shared base online:**
> https://github.com/Precisa-Saude/tooling/blob/main/packages/agent-instructions/AGENTS.md
>
> Claude Code loads both files (shared base + this one) via imports in
> `CLAUDE.md`. Update the base with:
> `pnpm update @precisa-saude/agent-instructions`.

## Overview

<!-- One or two sentences on what this repo does. -->

## Structure

```
packages/
  ...
site/  (if applicable)
```

## Publicar dados — leia antes de disparar workflow

Dois workflows publicam Parquet e eles **não** são intercambiáveis:

- `refresh.yml` — delta semanal, runner do GitHub, teto de **180 min**,
  reconstrói o `manifest.json`.
- `backfill.yml` — volume grande, runner **self-hosted** (`rafael-desktop-archive`),
  teto de **24h**, escopado por `ufs`/`years`/`months`, com watchdog. **Não**
  reconstrói o manifest.

Acima de ~20 partições pendentes, é `backfill.yml` em chunks, com SP/MG/RJ
num run separado. Um timeout **não preserva progresso** no runner do GitHub:
o upload ao S3 só acontece depois que todas as partições terminam.

Procedimento completo, incluindo verificação pós-publicação, em
[`docs/operations.md`](docs/operations.md).

## Commit scopes

Valid scopes: `data`, `schema`, `scripts`, `ci`, `deps`, `docs`, `lint`, `config`.

## Worktree — specific values

Worktree flow and commands are in the shared base. The canonical config
lives in `package.json` under `"worktree"`. For quick reference:

| Field         | Value                                      |
| ------------- | ------------------------------------------ |
| Port registry | `/tmp/datasus-parquet-worktree-ports.json` |
| Services      | (filled in when the repo adds dev servers) |

Launch a dev server in a feature worktree:

```bash
pnpm exec precisa-worktree dev --detach
```
