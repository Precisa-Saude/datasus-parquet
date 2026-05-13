# Consumindo os dados

Os arquivos Parquet são servidos publicamente via CloudFront
(`dfdu08vi8wsus.cloudfront.net`) com CORS permissivo. Consumidores
leem diretamente por HTTPS sem credenciais.

> Acesso anônimo ao bucket S3 (`s3://datasus-parquet/...`,
> `aws s3 ... --no-sign-request`) está **deprecado** e será desligado
> em breve — o bucket passa a aceitar requests apenas via CloudFront,
> com rate-limit por IP. Use as URLs HTTPS abaixo.

## DuckDB (recomendado)

Zero setup — DuckDB lê Parquet via HTTPS com Range Requests, puxando
só os row-groups que o filtro precisa.

### CLI

```bash
duckdb

D SELECT PA_CMP, COUNT(*) as n
  FROM read_parquet('https://dfdu08vi8wsus.cloudfront.net/sia-pa/ano=2024/uf=SP/mes=01/part.parquet')
  GROUP BY PA_CMP;
```

### Série histórica com schema evolution

```sql
SELECT PA_CMP, PA_UFMUN, COUNT(*) AS n
FROM read_parquet(
  'https://dfdu08vi8wsus.cloudfront.net/sia-pa/ano=*/uf=AC/mes=*/part.parquet',
  union_by_name = true
)
WHERE PA_CMP LIKE '2024%'
GROUP BY PA_CMP, PA_UFMUN
ORDER BY n DESC;
```

`union_by_name=true` aceita que o schema varie entre partições e
unifica por nome de coluna (colunas ausentes ficam NULL).

### Com filtro pushdown eficiente

```sql
-- O filtro `PA_CMP = '202401'` é pushed down pros row-group stats
-- do Parquet; só o row-group relevante é baixado.
SELECT PA_CODUNI, COUNT(*)
FROM read_parquet('https://dfdu08vi8wsus.cloudfront.net/sia-pa/ano=2024/uf=SP/mes=01/part.parquet')
WHERE PA_CMP = '202401'
GROUP BY PA_CODUNI;
```

## Python — Polars

```python
import polars as pl

# Lazy evaluation + streaming
df = (
    pl.scan_parquet(
        "s3://datasus-parquet/sia-pa/ano=2024/uf=SP/mes=*/part.parquet",
        storage_options={"region": "sa-east-1", "anonymous": True},
    )
    .filter(pl.col("PA_CMP") == "202401")
    .group_by("PA_CODUNI")
    .agg(pl.len())
    .collect()
)
```

## Python — Pandas via pyarrow

```python
import pyarrow.dataset as ds

dataset = ds.dataset(
    "s3://datasus-parquet/sia-pa/ano=2024/uf=SP/",
    format="parquet",
    filesystem=ds.fs.S3FileSystem(region="sa-east-1", anonymous=True),
)
df = dataset.to_table(filter=ds.field("PA_CMP") == "202401").to_pandas()
```

## R — arrow

```r
library(arrow)
library(dplyr)

bucket <- s3_bucket(
  "datasus-parquet",
  anonymous = TRUE,
  region = "sa-east-1"
)

ds <- open_dataset(bucket$path("sia-pa/ano=2024"), format = "parquet")

ds |>
  filter(PA_CMP == "202401") |>
  group_by(PA_CODUNI) |>
  summarise(n = n()) |>
  collect()
```

## Baixar um snapshot localmente

Se preferir trabalhar offline:

```bash
aws s3 sync \
  s3://datasus-parquet/sia-pa/ano=2024/ \
  ./sia-pa-2024/ \
  --no-sign-request

duckdb -c "SELECT COUNT(*) FROM read_parquet('./sia-pa-2024/**/*.parquet');"
```

## Limites a ter em mente

- **Bandwidth**: CloudFront absorve cache hits, mas queries
  sem filtro que escaneiam grandes volumes vão puxar muitos GB.
  Para análises intensas, baixe snapshot local (acima).
- **Range Requests**: DuckDB/Arrow/Polars fazem requisições parciais
  eficientes. Curl -O força download do arquivo inteiro — use só
  quando quer o arquivo completo.
- **SP em meses antigos**: pode estar ausente (split files). Ver
  [`datasets.md`](datasets.md#sia-pa).

## Ferramentas que funcionam out-of-the-box

- [DuckDB](https://duckdb.org/)
- [Polars](https://pola.rs/)
- [PyArrow](https://arrow.apache.org/docs/python/)
- [arrow-R](https://arrow.apache.org/docs/r/)
- [ClickHouse](https://clickhouse.com/) (via S3 table function)
- [Apache Spark](https://spark.apache.org/) (via S3 connector)
- [Pandas + fsspec](https://pandas.pydata.org/docs/user_guide/io.html#reading-remote-files)

## Suporte

Issues, dúvidas ou pedidos de novos datasets:
https://github.com/Precisa-Saude/datasus-parquet/issues
