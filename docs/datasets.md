# Datasets

Catálogo dos subdatasets DATASUS cobertos ou planejados. Cada linha
do catálogo tem o path FTP oficial, o layout de saída no arquivo
Parquet e um link pra documentação específica de schema.

O arquivo `build/manifest.json` (gerado pelo `scripts/build-manifest.ts`
em cada release) contém a cobertura atual — quais UFs × anos × meses
estão publicados, tamanho total, schema resumido.

## Ativos

### SIA-PA — Produção Ambulatorial

- **Fonte**: `ftp.datasus.gov.br/dissemin/publicos/SIASUS/200801_/Dados/`
- **Nomes**: `PA{UF}{YYMM}.dbc` (ex.: `PAAC2401.dbc` = Acre, jan/2024)
- **Cobertura publicada**: desde 2008 (quando o schema atual estabilizou).
  Dados de 2000–2007 seguem schema PAM/PAR antigo e não estão incluídos.
- **Saída**: `s3://datasus-parquet/sia-pa/ano=YYYY/uf=XX/mes=MM/part.parquet`
- **Schema**: ver [`schema/sia-pa.md`](schema/sia-pa.md)
- **Caveats**:
  - **SP tem split files** em meses de alta produção (`PASP{YY}{MM}a.dbc`,
    `b.dbc`, `c.dbc`). O decoder `@precisa-saude/datasus-dbc` atualmente
    não suporta split files; SP fica ausente para essas competências.
    Issue aberta.
  - Sub-registro conhecido do SIA — só reflete o que foi faturado ao SUS.
    Exames da rede privada, SUS municipalizado sem faturamento
    centralizado, ou procedimentos não faturados não aparecem.

## Planejados (contribuições bem-vindas)

Todos têm o decoder pronto via `@precisa-saude/datasus-dbc`; falta
apenas escrever o script `archive-<dataset>.ts` e um
`docs/schema/<dataset>.md`.

### SIH-RD — Internações Hospitalares (AIH Reduzida)

- **Fonte**: `ftp.datasus.gov.br/dissemin/publicos/SIHSUS/200801_/Dados/`
- **Nomes**: `RD{UF}{YYMM}.dbc`
- **Use case**: mortalidade hospitalar, procedimentos cirúrgicos,
  internações por CID-10

### SIM — Mortalidade

- **Fonte**: `ftp.datasus.gov.br/dissemin/publicos/SIM/CID10/DORES/`
- **Nomes**: `DO{UF}{YYYY}.dbc`
- **Use case**: causas de óbito, expectativa de vida, epidemiologia

### SINASC — Nascidos Vivos

- **Fonte**: `ftp.datasus.gov.br/dissemin/publicos/SINASC/NOV/DNRES/`
- **Nomes**: `DN{UF}{YYYY}.dbc`
- **Use case**: natalidade, prematuridade, peso ao nascer

### SINAN — Sistema de Agravos de Notificação

- **Fonte**: `ftp.datasus.gov.br/dissemin/publicos/SINAN/DADOS/FINAIS/`
- **Nomes**: `{AGRAVO}BR{YY}.dbc` (ex.: `DENGBR23.dbc`, `ZIKABR23.dbc`)
- **Use case**: epidemia, vigilância, surtos (dengue, zika, chikungunya,
  hanseníase, tuberculose, etc.)
- **Nota**: SINAN é **nacional por arquivo** (não particionado por UF)

### CNES-ST — Cadastro Nacional de Estabelecimentos / Estabelecimentos

- **Fonte**: `ftp.datasus.gov.br/dissemin/publicos/CNES/200508_/Dados/ST/`
- **Nomes**: `ST{UF}{YYMM}.dbc`
- **Use case**: inventário de estabelecimentos de saúde, capacidade
  instalada, tipo de atendimento

## Como adicionar um novo dataset

Veja [`contributing.md`](contributing.md).
