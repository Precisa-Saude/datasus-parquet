# datasus-parquet

[![CI](https://github.com/Precisa-Saude/datasus-parquet/actions/workflows/ci.yml/badge.svg)](https://github.com/Precisa-Saude/datasus-parquet/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Data License: CC-BY-4.0](https://img.shields.io/badge/Data_License-CC--BY_4.0-lightgrey.svg)](https://creativecommons.org/licenses/by/4.0/)

**Arquivo público de microdados do DATASUS em formato Parquet.** Conversão 1:1 a partir dos DBC/DBF originais do `ftp.datasus.gov.br`, com zero transformação semântica — todas as colunas preservadas, schema por partição, provenance com SHA256 dos arquivos-fonte.

Mantido pela [Precisa Saúde](https://precisa-saude.com.br) como recurso para pesquisa epidemiológica. Dados sob regime de dados abertos (Lei 12.527/2011, Decreto 8.777/2016); nossa compilação e derivações sob CC-BY 4.0.

---

## Datasets publicados

| Dataset                               | Status       | Cobertura     | Schema                                             |
| ------------------------------------- | ------------ | ------------- | -------------------------------------------------- |
| **SIA-PA** (Produção Ambulatorial)    | ✅ ativo     | 2008–presente | [`docs/schema/sia-pa.md`](docs/schema/sia-pa.md)   |
| **SIH-RD** (Internações Hospitalares) | 🟡 planejado | —             | [`docs/schema/sih-rd.md`](docs/schema/sih-rd.md)   |
| **SIM** (Mortalidade)                 | 🟡 planejado | —             | [`docs/schema/sim.md`](docs/schema/sim.md)         |
| **SINASC** (Nascidos Vivos)           | 🟡 planejado | —             | [`docs/schema/sinasc.md`](docs/schema/sinasc.md)   |
| **SINAN** (Agravos Notificáveis)      | 🟡 planejado | —             | [`docs/schema/sinan.md`](docs/schema/sinan.md)     |
| **CNES-ST** (Estabelecimentos)        | 🟡 planejado | —             | [`docs/schema/cnes-st.md`](docs/schema/cnes-st.md) |

Datasets marcados como planejados têm schema documentado e decoder
pronto (`@precisa-saude/datasus-dbc`); falta apenas o script
`scripts/archive-<dataset>.ts`. Contribuições de pesquisadores que
trabalham com esses subdatasets são bem-vindas — veja
[`docs/contributing.md`](docs/contributing.md) e use
`scripts/archive-sia-pa.ts` como template.

---

## Como consumir

### DuckDB (recomendado — zero setup)

```sql
-- Todos os exames de jan/2024 em SP:
SELECT *
FROM read_parquet('https://dfdu08vi8wsus.cloudfront.net/sia-pa/ano=2024/uf=SP/mes=01/part.parquet');

-- Série histórica de uma UF (schema evolution automática):
SELECT PA_CMP, COUNT(*)
FROM read_parquet(
  'https://dfdu08vi8wsus.cloudfront.net/sia-pa/ano=*/uf=AC/mes=*/part.parquet',
  union_by_name = true
)
GROUP BY PA_CMP
ORDER BY PA_CMP;
```

### Python (Polars / Pandas via pyarrow)

```python
import polars as pl
df = pl.scan_parquet(
    "s3://datasus-parquet/sia-pa/ano=2024/uf=SP/mes=*/part.parquet",
    storage_options={"region": "sa-east-1"},
).collect()
```

### R (arrow)

```r
library(arrow)
ds <- open_dataset(
  "s3://datasus-parquet/sia-pa/ano=2024/uf=SP",
  format = "parquet"
)
```

---

## Layout dos dados

```
s3://datasus-parquet/
  sia-pa/
    ano=YYYY/uf=XX/mes=MM/part.parquet
    provenance/ano=YYYY/uf=XX/mes=MM/part.provenance.json
  sih-rd/
    …
  manifest.json           — catálogo completo (datasets, cobertura, schema)
```

Partição por **mês** preserva o schema do DBF-fonte daquela competência.
`union_by_name=true` no DuckDB ou `unified_schema=True` no Arrow lidam
com evolução cross-year transparentemente.

---

## Validação byte-a-byte

Cada partição tem um `part.provenance.json` com SHA256 do DBC-fonte
original do FTP DATASUS. Para validar:

1. Baixe o `PA{UF}{YYMM}.dbc` direto de
   `ftp://ftp.datasus.gov.br/dissemin/publicos/SIASUS/200801_/Dados/`
2. `sha256sum PA{UF}{YYMM}.dbc` → compare com `sources[].sha256` do
   provenance
3. Se bate, clone este repo no `gitSha` indicado no provenance, rode
   `pnpm archive-sia-pa --ufs XX --years YYYY` e compare o Parquet
   emitido byte-a-byte com o publicado

Detalhes em [`docs/provenance.md`](docs/provenance.md).

---

## Automação

GH Actions sonda o FTP DATASUS semanalmente, detecta novas competências
publicadas, converte o delta em Parquet, faz upload para S3 e cria um
GitHub Release com os assets daquela janela. Cada release vira um DOI
Zenodo.

Ciclo:

```
ftp.datasus.gov.br → detect-new → archive-<dataset> → provenance → S3 → Release + Zenodo DOI
```

Workflow em [`.github/workflows/refresh.yml`](.github/workflows/refresh.yml).

> **Site `datasus-viz` e cadeia _end-to-end_:** este repo publica os
> _Parquets brutos_ no S3 — o site `datasus-viz` consome via CloudFront,
> agrega para LOINC e republica artefatos otimizados. A cadeia inteira
> (com a _gotcha_ "novo ano no S3 não aparece sozinho no site") está
> documentada em
> [`datasus-viz/site/docs/data-pipeline.md`](https://github.com/Precisa-Saude/datasus-viz/blob/main/site/docs/data-pipeline.md#pipeline-end-to-end-datasus-parquet--datasus-viz).

---

## Como adicionar um novo dataset

Veja [`docs/contributing.md`](docs/contributing.md). Em resumo:

1. Decida o subpath FTP oficial (ex.: `/dissemin/publicos/SIHSUS/…` pro
   SIH-RD).
2. Implemente `scripts/archive-<dataset>.ts` seguindo o padrão de
   `scripts/archive-sia-pa.ts`.
3. Crie `docs/schema/<dataset>.md` documentando colunas e referências
   ao dicionário oficial DATASUS.
4. Adicione ao matrix do workflow `.github/workflows/refresh.yml`.
5. Abra PR. Maintainers revisam, mergeiam, e a partir do próximo cron
   semanal o dataset entra no ciclo.

---

## Licença

- **Código** (scripts, workflows, docs): Apache-2.0
  ([LICENSE](LICENSE))
- **Dados publicados** (Parquet + provenance): CC-BY 4.0
  — compilação/derivação nossa; dados brutos seguem regime de dados
  abertos (Lei 12.527, Decreto 8.777)

---

## Citação

Ver [`CITATION.cff`](CITATION.cff) + DOI emitido por release do Zenodo.

---

## Referências

- DATASUS FTP: `ftp.datasus.gov.br/dissemin/publicos/`
- TabNet (visualização oficial): http://tabnet.datasus.gov.br
- Dicionários oficiais: veja `docs/schema/<dataset>.md` de cada dataset
- [`@precisa-saude/datasus-dbc`](https://github.com/Precisa-Saude/datasus-dbc) —
  decoder DBC em TypeScript usado pelo pipeline
- [`@precisa-saude/datasus-sdk`](https://github.com/Precisa-Saude/datasus-sdk) —
  SDK de alto nível (schemas tipados, FTP, terminologia)
- [`datasus-viz`](https://github.com/Precisa-Saude/datasus-viz) —
  site/CLI de visualização consumindo este arquivo
