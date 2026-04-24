# Contribuindo

Este repositório é pensado pra receber scripts de archival de mais
datasets DATASUS conforme pesquisadores interessados em subdatasets
específicos forem aparecendo. O decoder DBC já está pronto —
adicionar um dataset novo é basicamente:

1. Escrever um script TypeScript que itera no FTP, decoda, escreve
   Parquet.
2. Documentar o schema.
3. Adicionar ao workflow de refresh.

## Requisitos locais

- Node.js 22+
- pnpm (`corepack enable`)
- Cerca de 1-2 GB de espaço em disco pra cache FTP local durante testes

```bash
git clone https://github.com/Precisa-Saude/datasus-parquet.git
cd datasus-parquet
pnpm install
```

## Estrutura de um dataset novo

Cada dataset ocupa um "slot" em três lugares:

1. **`scripts/archive-<dataset>.ts`** — converte DBC → Parquet.
   Sem transformação semântica. Template em
   `scripts/archive-sia-pa.ts`.
2. **`state/<dataset>.json`** — state file com a última competência
   processada por UF. Inicializado vazio com
   `{"schemaVersion": 1, "lastRun": "", "processed": {}}`.
3. **`scripts/detect-new.ts`** — adicione uma entrada no mapa
   `DATASETS` com o path FTP + regex de nomes + parser (uf, ano, mês).
4. **`scripts/emit-provenance.ts`** — adicione uma entrada no mapa
   `DATASET_CONFIG` com o `ftpBase` e `sourceFileFor`.
5. **`docs/schema/<dataset>.md`** — descrição das colunas, charset,
   referências, caveats. **Para SIH-RD, SIM, SINASC, SINAN e CNES-ST
   a spec já existe** em `docs/schema/`; refine e complete com base
   no DBF real (especialmente os `Campos específicos por agravo` do
   SINAN).
6. **`docs/datasets.md`** — mover a entrada de "Planejados" para
   "Ativos" quando o script for publicado.
7. **`.github/workflows/refresh.yml`** — se precisar de passos
   específicos (raro; o workflow genérico cobre o padrão "uma
   partição por UF×competência").

## Padrões que o script de archival deve seguir

- **Sem filtro semântico**: preserve todas as colunas `XXXX_*` do DBF.
  Transformações aceitáveis: CP850→UTF-8 (via decoder) e conversão de
  tipos DBF→Parquet.
- **Determinismo**: `ORDER BY <coluna-tempo>, <coluna-chave>` no COPY
  TO. Mesmo DBC + mesmo gitSha = mesmo Parquet byte-a-byte.
- **Idempotência**: se a partição de saída já existe com tamanho > 0,
  pule. Deletar o arquivo manualmente força re-emissão.
- **Formato consistente**: `ano=YYYY/uf=XX/mes=MM/part.parquet`.
  Exceção: datasets nacionais não particionados por UF (ex.: SINAN)
  podem usar `ano=YYYY/part.parquet` ou
  `ano=YYYY/agravo=XXX/part.parquet`.

## Padrão de nomes nos scripts

| Convenção         | Exemplo                                 |
| ----------------- | --------------------------------------- |
| Script            | `scripts/archive-<dataset>.ts`          |
| State             | `state/<dataset>.json`                  |
| Build output      | `build/<dataset>/ano=YYYY/…`            |
| Provenance output | `build/<dataset>/provenance/ano=YYYY/…` |
| Package script    | `archive-<dataset>` em `package.json`   |

## Checklist de PR

Um PR que adiciona um dataset novo deve incluir:

- [ ] `scripts/archive-<dataset>.ts` com testes exemplares
- [ ] Entrada em `DATASETS` de `detect-new.ts`
- [ ] Entrada em `DATASET_CONFIG` de `emit-provenance.ts`
- [ ] `state/<dataset>.json` inicial vazio
- [ ] `docs/schema/<dataset>.md` completo (refinado da spec existente
      com base no DBF real — tipos, campos opcionais específicos de
      vintage, caveats de encoding)
- [ ] Atualização de `docs/datasets.md` (mover de "Planejados" pra
      "Ativos")
- [ ] Teste manual: `pnpm archive-<dataset> -- --ufs AC --years 2023`
      emite um Parquet válido que o DuckDB consegue abrir.
- [ ] `pnpm typecheck` limpo

## Testes

Teste o archival local com uma UF pequena (AC, AP, RR) e um único ano
recente. Depois confira:

```bash
duckdb -c "SELECT COUNT(*) FROM read_parquet('build/<dataset>/ano=*/uf=*/mes=*/part.parquet', union_by_name=true);"
duckdb -c "DESCRIBE SELECT * FROM read_parquet('build/<dataset>/ano=2023/uf=AC/mes=01/part.parquet')` emite Parquet válido.
```

Compare linha-a-linha com uma query TabNet oficial (quando disponível)
pra sanity-check de totais.

## Para quem quer contribuir mas não programa

Abra uma issue descrevendo:

- Qual dataset você gostaria de ver publicado
- Seu caso de uso acadêmico
- Se há alguma referência ao schema oficial que podemos citar

Com interesse confirmado, podemos escrever os scripts internamente.
Prioridade é proporcional à comunidade que usaria.

## Governança

Maintainers (hoje: time Precisa Saúde) revisam PRs. Critérios de
aceitação:

- Não adiciona novas dependências pesadas sem justificativa
- Segue as convenções acima
- Schema docado referencia fonte oficial do DATASUS
- Nenhum tipo de filtro/transformação semântica no archival

Dúvidas? Abra uma issue.
