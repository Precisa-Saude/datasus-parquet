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
    "fingerprint": "v1:462192:15454E690ECE470AA0AEE:8E22F8F5EC55E60E",
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

### Partição publicada em mais de um DBC

Alguns meses de UFs grandes (SP desde 2013, MG e RJ desde 2021, alguns de
PR e RS) não têm o DBC canônico `PA{UF}{AA}{MM}.dbc`: o DBF excede o
limite de 2 GB do formato e o DATASUS publica `PA{UF}{AA}{MM}a.dbc`,
`…b.dbc` etc., com registros disjuntos. O Parquet da partição é a
concatenação das variantes, nessa ordem. O provenance registra cada uma em
`sources`, com os mesmos campos de `source`, e `source` fica `null`:

```json
{
  "dataset": "sia-pa",
  "partition": { "ano": 2025, "mes": 8, "uf": "MG" },
  …
  "source": null,
  "sources": [
    {
      "bytes": 166934835,
      "file": "PAMG2508a.dbc",
      "ftpPath": "/dissemin/publicos/SIASUS/200801_/Dados/PAMG2508a.dbc",
      "mtime": "2026-09-30T22:02:13.173Z",
      "sha256": "aec600604746d43cebf50eafbb4d8a3b9661a2bf83cd66138156ee5a73dd7a8e"
    },
    { "bytes": 213060888, "file": "PAMG2508b.dbc", … },
    { "bytes": 15204829, "file": "PAMG2508c.dbc", … }
  ]
}
```

Regras:

- **Um DBC** → só `source`, sem `sources` (formato inalterado).
- **Mais de um DBC** → `source: null` e `sources` com um item por arquivo.
  `source` não aponta para nenhuma das variantes de propósito: nenhuma
  delas, sozinha, é a fonte do Parquet. Quem lia `source.sha256` recebe
  `null` em vez de um hash que não confere.
- Nunca há `bytes: 0`, hash vazio ou `mtime` vazio. Se um DBC da partição
  não está no cache, tem 0 byte ou não pode ser lido, o `emit-provenance`
  falha (sai com erro, listando as partições) e não escreve o provenance
  dela. Os arquivos de 0 byte que tentativas antigas deixaram no cache
  (por exemplo `PAMG2508.dbc`) são ignorados na escolha dos arquivos.
- Os arquivos são escolhidos pela mesma regra do `archive-sia-pa`
  (`resolvePartitionFiles` em `scripts/lib/dbc-source.ts`): o canônico se
  existir, senão as variantes `a`–`e` presentes, em ordem.

`mtime` é o do arquivo no cache local (quando foi baixado), não o do FTP.

> **Provenance publicado antes de 19/11/2026.** Nas partições divididas, o
> provenance gerado antes desta regra traz `source.file` com o nome
> canônico (que não existe no FTP), `source.bytes: 0` e `source.sha256`
> igual ao hash de arquivo vazio (`e3b0c442…`) ou vazio. O Parquet dessas
> partições está correto; só o provenance não confere com o FTP até ser
> regerado.

`output.fingerprint` é a impressão do **conteúdo** (md5 do JSON de cada
linha, combinado por soma e XOR, mais a contagem — `v1:<linhas>:<soma>:<xor>`).
Ao contrário do `sha256`, não depende da ordem das linhas nem da versão
do DuckDB que escreveu o Parquet. O refresh a usa para não republicar
partição cujo DBC o DATASUS re-exportou sem mudar o conteúdo; nesse caso o
provenance publicado continua sendo o da decodificação original, e o
`source` descreve o DBC daquela época, não o re-exportado.

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

Partição com `sources` (DBC dividido): baixe e confira cada arquivo da
lista. Com `jq`:

```bash
PROV=part.provenance.json
jq -r '.sources[] | "\(.sha256)  \(.file)"' "$PROV" > esperado.sha256
jq -r '.sources[].ftpPath' "$PROV" | while read -r ftp_path; do
  curl -sO "ftp://ftp.datasus.gov.br${ftp_path}"
done
shasum -a 256 -c esperado.sha256
# Cada linha deve sair "OK". Confira também que a listagem do FTP não tem
# variante a mais (por exemplo um `…d.dbc` que não está em `sources`).
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
