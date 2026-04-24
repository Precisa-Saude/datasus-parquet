# Schema — SIM (Mortalidade)

**Status**: 🟡 planejado — schema doc como referência para contribuintes
que implementem `scripts/archive-sim.ts`.

**Fonte oficial**: [Dicionário de dados SIM](https://opendatasus.saude.gov.br/dataset/sim),
arquivo "Layout DO.pdf" ou equivalente.

**Schema vintage**: SIM CID-10 (desde 1996). O arquivo está em CID-10
desde 1996 — antes disso usava CID-9 (formato diferente, fora do escopo
atual). A estrutura do DO (Declaração de Óbito) teve duas grandes
revisões: DO 2010 e DO 2011+ atual.

## Partições

```
s3://datasus-parquet/sim/ano=YYYY/uf=XX/part.parquet
```

Grão = (UF, ano) — `DO{UF}{YYYY}.dbc` no FTP (anual, não mensal).
Provenance acompanha o mesmo grão.

## Colunas principais (DO 2011+)

| Coluna       | Tipo    | Descrição                                                       |
| ------------ | ------- | --------------------------------------------------------------- |
| `NUMERODO`   | VARCHAR | Número da Declaração de Óbito (identificador único)             |
| `TIPOBITO`   | VARCHAR | Tipo de óbito (1=fetal, 2=não-fetal)                            |
| `DTOBITO`    | VARCHAR | Data do óbito (AAAAMMDD)                                        |
| `HORAOBITO`  | VARCHAR | Hora do óbito (HHMM)                                            |
| `NATURAL`    | VARCHAR | Naturalidade (código do país/UF)                                |
| `CODMUNNATU` | VARCHAR | Município de naturalidade (IBGE 6 díg.)                         |
| `DTNASC`     | VARCHAR | Data de nascimento (AAAAMMDD)                                   |
| `IDADE`      | VARCHAR | Idade (4 díg: 1º=unidade, 3 últimos=valor)                      |
| `SEXO`       | VARCHAR | Sexo (0=ignorado, 1=M, 2=F)                                     |
| `RACACOR`    | VARCHAR | Raça/cor (1=branca, 2=preta, 3=amarela, 4=parda, 5=indígena)    |
| `ESTCIV`     | VARCHAR | Estado civil                                                    |
| `ESC`        | VARCHAR | Escolaridade (1–5, 9)                                           |
| `ESC2010`    | VARCHAR | Escolaridade DO 2010                                            |
| `OCUP`       | VARCHAR | Ocupação (CBO)                                                  |
| `CODMUNRES`  | VARCHAR | Município de residência (IBGE 6 díg.)                           |
| `LOCOCOR`    | VARCHAR | Local de ocorrência (1=hospital, 2=outro saúde, etc.)           |
| `CODESTAB`   | VARCHAR | CNES do estabelecimento de ocorrência                           |
| `ESTABDESCR` | VARCHAR | Nome do estabelecimento (quando não tem CNES)                   |
| `CODMUNOCOR` | VARCHAR | Município de ocorrência (IBGE 6 díg.)                           |
| `CAUSABAS`   | VARCHAR | Causa básica do óbito (CID-10, 4 díg.)                          |
| `CAUSABAS_O` | VARCHAR | Causa básica — original (antes de processamento SCB)            |
| `LINHAA`     | VARCHAR | Parte I linha A — causa direta                                  |
| `LINHAB`     | VARCHAR | Parte I linha B                                                 |
| `LINHAC`     | VARCHAR | Parte I linha C                                                 |
| `LINHAD`     | VARCHAR | Parte I linha D                                                 |
| `LINHAII`    | VARCHAR | Parte II — outros estados mórbidos                              |
| `ATESTANTE`  | VARCHAR | Quem atestou (1=médico assistente, 2=substituto, etc.)          |
| `ASSISTMED`  | VARCHAR | Recebeu assistência médica (1=sim, 2=não)                       |
| `NECROPSIA`  | VARCHAR | Houve necropsia (1=sim, 2=não)                                  |
| `TPMORTEOCO` | VARCHAR | Tipo de morte (mulheres 10-49)                                  |
| `OBITOPARTO` | VARCHAR | Relação com parto                                               |
| `OBITOGRAV`  | VARCHAR | Gravidez                                                        |
| `OBITOPUERP` | VARCHAR | Puerpério                                                       |
| `CIRCOBITO`  | VARCHAR | Circunstância (morte não natural: 1=acidente, 2=suicídio, etc.) |
| `ACIDTRAB`   | VARCHAR | Acidente de trabalho                                            |
| `FONTE`      | VARCHAR | Fonte da informação                                             |
| `FONTEINV`   | VARCHAR | Fonte da investigação                                           |
| `DTRECEBIM`  | VARCHAR | Data de recebimento (AAAAMMDD)                                  |
| `DTRECORIGA` | VARCHAR | Data recebimento original                                       |
| `DTINVESTIG` | VARCHAR | Data da investigação                                            |
| `DTATESTADO` | VARCHAR | Data do atestado                                                |
| `FONTES`     | VARCHAR | Fontes consultadas                                              |

## Charset / encoding

CP850/Latin-1 nos campos de texto — decoder converte pra UTF-8.

## Códigos de referência

- **CID-10** (`CAUSABAS`, `CAUSABAS_O`, `LINHA*`): 4 dígitos alfanuméricos
- **IBGE município** (`CODMUNRES`, `CODMUNOCOR`): 6 dígitos
- **CNES** (`CODESTAB`): 7 dígitos
- **CBO** (`OCUP`): 6 dígitos

## Caveats

- **Sub-registro**: SIM tem sub-registro em regiões Norte/Nordeste
  (especialmente mortalidade fetal/infantil). Para análises comparativas,
  cruzar com estimativas IBGE e projeções de Mortinatalidade do MS.
- **Causa básica**: `CAUSABAS` é processada pelo SCB (Seletor de Causa
  Básica) — pode diferir da causa declarada pelo médico. `CAUSABAS_O`
  preserva o valor original.
- Mudança de DO 2010 → DO 2011 introduziu novos campos (`ESC2010` vs
  `ESC`, `TPMORTEOCO`). Análises longitudinais precisam tratar essa
  descontinuidade.

## Use cases típicos

- Curvas de mortalidade por causa (CID-10) × ano × UF
- Mortalidade infantil, materna, fetal
- Mortalidade por causas externas (acidentes, suicídios, homicídios)
- Expectativa de vida por município

## Referências

- [SIM — Manuais](http://svs.aids.gov.br/dantps/centrais-de-conteudos/publicacoes/)
- [TabNet SIM](http://tabnet.datasus.gov.br/cgi/tabcgi.exe?sim/cnv/obt10uf.def)
- [OpenDataSUS SIM](https://opendatasus.saude.gov.br/dataset/sim)
