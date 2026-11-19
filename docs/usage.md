# Consumindo os dados

Os arquivos Parquet são servidos publicamente via CloudFront
(`dfdu08vi8wsus.cloudfront.net`) com CORS permissivo. Consumidores
leem diretamente por HTTPS sem credenciais.

> O bucket S3 de origem é privado e só aceita leitura vinda do
> CloudFront. Caminhos `s3://` e `aws s3 ... --no-sign-request` não
> funcionam; use as URLs HTTPS abaixo.

## Listar os arquivos: `manifest.json`

HTTP não lista diretório, então um curinga como `ano=*/uf=AC/mes=*` não
funciona numa URL. Para ler várias partições, monte a lista a partir do
`manifest.json`, que traz as competências e UFs publicadas:

```
https://dfdu08vi8wsus.cloudfront.net/manifest.json
```

```json
{
  "datasets": {
    "sia-pa": {
      "competencias": ["2008-01", "2008-02", "..."],
      "ufs": ["AC", "AL", "..."],
      "partitions": 6048,
      "bytes": 57260712457
    }
  }
}
```

Cada partição fica em
`sia-pa/ano=YYYY/uf=XX/mes=MM/part.parquet`.

## DuckDB (recomendado)

Zero setup: o DuckDB lê Parquet via HTTPS com Range Requests, puxando
só as colunas e os row-groups que a consulta precisa.

### Uma partição

```sql
SELECT PA_CMP, COUNT(*) AS n
FROM read_parquet('https://dfdu08vi8wsus.cloudfront.net/sia-pa/ano=2024/uf=SP/mes=01/part.parquet')
GROUP BY PA_CMP;
```

### Série histórica com schema evolution

```sql
SET VARIABLE arquivos = (
  SELECT list(format('https://dfdu08vi8wsus.cloudfront.net/sia-pa/ano={}/uf=AC/mes={}/part.parquet',
                     c[1:4], c[6:7]))
  FROM (SELECT unnest(datasets."sia-pa".competencias) AS c
        FROM read_json('https://dfdu08vi8wsus.cloudfront.net/manifest.json'))
);

SELECT ano, COUNT(*) AS linhas
FROM read_parquet(getvariable('arquivos'), hive_partitioning = true, union_by_name = true)
GROUP BY ano
ORDER BY ano;
```

`hive_partitioning=true` expõe `ano`, `uf` e `mes` como colunas.
`union_by_name=true` aceita que o schema varie entre partições e
unifica por nome de coluna (colunas ausentes ficam NULL).

Para restringir o período, filtre as competências antes de montar a
lista (`WHERE c >= '2024-01'`): assim os outros arquivos nem são
abertos.

### Com filtro pushdown eficiente

```sql
-- O filtro `PA_CMP = '202401'` é pushed down pros row-group stats
-- do Parquet; só o row-group relevante é baixado.
SELECT PA_CODUNI, COUNT(*)
FROM read_parquet('https://dfdu08vi8wsus.cloudfront.net/sia-pa/ano=2024/uf=SP/mes=01/part.parquet')
WHERE PA_CMP = '202401'
GROUP BY PA_CODUNI;
```

## Python com DuckDB

```python
import duckdb

con = duckdb.connect()
con.sql("""
SET VARIABLE arquivos = (
  SELECT list(format('https://dfdu08vi8wsus.cloudfront.net/sia-pa/ano={}/uf=AC/mes={}/part.parquet',
                     c[1:4], c[6:7]))
  FROM (SELECT unnest(datasets."sia-pa".competencias) AS c
        FROM read_json('https://dfdu08vi8wsus.cloudfront.net/manifest.json'))
  WHERE c >= '2024-01'
)
""")
df = con.sql("""
SELECT mes, COUNT(*) AS linhas
FROM read_parquet(getvariable('arquivos'), hive_partitioning = true, union_by_name = true)
WHERE ano = 2024
GROUP BY mes ORDER BY mes
""").df()
```

## Python com Polars

```python
import json
import urllib.request

import polars as pl

BASE = "https://dfdu08vi8wsus.cloudfront.net"
with urllib.request.urlopen(f"{BASE}/manifest.json") as r:
    competencias = json.load(r)["datasets"]["sia-pa"]["competencias"]

urls = [
    f"{BASE}/sia-pa/ano={c[:4]}/uf=SP/mes={c[5:]}/part.parquet"
    for c in competencias
    if c.startswith("2024")
]

df = (
    pl.scan_parquet(urls, hive_partitioning=True)
    .filter(pl.col("PA_CMP") == "202401")
    .group_by("PA_CODUNI")
    .agg(pl.len())
    .collect()
)
```

## R com DuckDB

```r
library(DBI)

con <- dbConnect(duckdb::duckdb())
dbExecute(con, "
SET VARIABLE arquivos = (
  SELECT list(format('https://dfdu08vi8wsus.cloudfront.net/sia-pa/ano={}/uf=AC/mes={}/part.parquet',
                     c[1:4], c[6:7]))
  FROM (SELECT unnest(datasets.\"sia-pa\".competencias) AS c
        FROM read_json('https://dfdu08vi8wsus.cloudfront.net/manifest.json'))
  WHERE c >= '2024-01'
)")
dbGetQuery(con, "
SELECT PA_CODUNI, COUNT(*) AS n
FROM read_parquet(getvariable('arquivos'), hive_partitioning = true, union_by_name = true)
WHERE PA_CMP = '202401'
GROUP BY PA_CODUNI")
```

## Baixar um snapshot localmente

Se preferir trabalhar offline, baixe as partições com `curl` a partir
do manifest (precisa de `jq`). O exemplo baixa 2024 de todas as UFs:

```bash
BASE=https://dfdu08vi8wsus.cloudfront.net
manifest=$(curl -sf "$BASE/manifest.json")
for c in $(jq -r '.datasets["sia-pa"].competencias[] | select(startswith("2024"))' <<<"$manifest"); do
  for uf in $(jq -r '.datasets["sia-pa"].ufs[]' <<<"$manifest"); do
    p="sia-pa/ano=${c:0:4}/uf=$uf/mes=${c:5:2}/part.parquet"
    curl -sf --create-dirs -o "$p" "$BASE/$p"
  done
done

duckdb -c "SELECT COUNT(*) FROM read_parquet('sia-pa/**/*.parquet');"
```

Os arquivos baixados são os mesmos bytes publicados, então o SHA256
confere com o `part.provenance.json` de cada partição.

## Limites a ter em mente

- **Limite de requisições por IP**: o CloudFront tem um rate-limit por
  IP. Uma consulta sobre muitas partições faz centenas de Range
  Requests e pode estourar o limite; a partir daí toda requisição
  responde `403` por alguns minutos, inclusive o `manifest.json`.
  Restrinja o período e as UFs na lista de arquivos, ou baixe um
  snapshot local para análises longas.
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
- [ClickHouse](https://clickhouse.com/) (via função de tabela `url`)
- [Apache Spark](https://spark.apache.org/)
- [Pandas + fsspec](https://pandas.pydata.org/docs/user_guide/io.html#reading-remote-files)

## Suporte

Issues, dúvidas ou pedidos de novos datasets:
https://github.com/Precisa-Saude/datasus-parquet/issues
