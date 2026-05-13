# Provenance e validação

Cada partição Parquet publicada tem um JSON de procedência que
permite a qualquer pesquisador validar, byte-a-byte, que o Parquet
é derivado do DBC oficial do DATASUS sem adulteração.

## Estrutura

Para cada `<dataset>/ano=YYYY/uf=XX/mes=MM/part.parquet`, existe
`<dataset>/provenance/ano=YYYY/uf=XX/mes=MM/part.provenance.json`:

```json
{
  "dataset": "sia-pa",
  "partition": { "ano": 2024, "mes": 1, "uf": "AC" },
  "source": {
    "file": "PAAC2401.dbc",
    "ftpPath": "/dissemin/publicos/SIASUS/200801_/Dados/PAAC2401.dbc",
    "sha256": "a1b2c3d4…",
    "bytes": 845321,
    "mtime": "2025-02-15T14:22:00Z"
  },
  "output": {
    "file": "ano=2024/uf=AC/mes=01/part.parquet",
    "sha256": "e5f6a7b8…",
    "rows": 462192,
    "columns": 47,
    "schema": [
      { "name": "PA_CODUNI", "type": "VARCHAR" },
      { "name": "PA_CMP", "type": "VARCHAR" },
      …
    ]
  },
  "pipeline": {
    "archiveScript": "scripts/archive-sia-pa.ts@<gitSha>",
    "decoder": "@precisa-saude/datasus-dbc@X.Y.Z",
    "datasusSdk": "@precisa-saude/datasus@X.Y.Z",
    "notes": "Conversão 1:1 DBC→Parquet, sem filtro, sem enriquecimento."
  },
  "generatedAt": "2026-04-24T12:00:00Z"
}
```

## Como validar

### Passo 1 — validar o DBC-fonte contra o FTP oficial

```bash
# 1. Baixe do FTP DATASUS:
curl -o PAAC2401.dbc \
  'ftp://ftp.datasus.gov.br/dissemin/publicos/SIASUS/200801_/Dados/PAAC2401.dbc'

# 2. Verifique o SHA256:
shasum -a 256 PAAC2401.dbc
# Deve bater com `source.sha256` do provenance.
```

Se bate, o DBC usado pelo pipeline é idêntico ao que está no FTP
oficial agora. Se não bate, pode ser:

- O DATASUS republicou o arquivo (edição pós-publicação). Nesse caso
  o próximo refresh automático vai detectar (compara size/mtime) e
  emitir uma nova partição.
- O arquivo no cache local foi corrompido. Re-baixe com
  `rm -rf ~/.cache/datasus-brasil/.../PAAC2401.dbc && pnpm archive-sia-pa
-- --ufs AC --years 2024`.

### Passo 2 — validar o Parquet emitido

```bash
# 1. Baixe o Parquet:
curl -o part.parquet \
  'https://dfdu08vi8wsus.cloudfront.net/sia-pa/ano=2024/uf=AC/mes=01/part.parquet'

# 2. Verifique o SHA256:
shasum -a 256 part.parquet
# Deve bater com `output.sha256` do provenance.
```

### Passo 3 — re-executar o pipeline e comparar byte-a-byte (opcional)

```bash
git clone https://github.com/Precisa-Saude/datasus-parquet.git
cd datasus-parquet
git checkout <gitSha do provenance.pipeline.archiveScript>
pnpm install --frozen-lockfile
pnpm archive-sia-pa -- --ufs AC --years 2024
shasum -a 256 build/sia-pa/ano=2024/uf=AC/mes=01/part.parquet
# Deve bater byte-a-byte com o Parquet publicado.
```

### Por que determinismo byte-a-byte?

O `archive-sia-pa.ts` usa:

- `ORDER BY (PA_CMP, PA_CODUNI)` na escrita — fixa a ordem física
- `COMPRESSION ZSTD` (default determinístico em zstd)
- `ROW_GROUP_SIZE 100000` — row-groups com mesmo tamanho
- `maximum_object_size=67108864` no JSON intermediário — estável

Com o mesmo DBC fonte + mesmo gitSha, o Parquet emitido é byte-idêntico.

## Quando o provenance não bate

Se `source.sha256` bate mas `output.sha256` não bate quando você
re-executa o pipeline, reporte como issue em
https://github.com/Precisa-Saude/datasus-parquet/issues com:

- DBC usado (SHA256, path)
- gitSha do pipeline
- SHA256 do Parquet que você gerou
- Plataforma (OS, Node version, DuckDB version)

Variações de encoding de números float em plataformas diferentes
podem causar divergências raras. Trataremos caso a caso.
