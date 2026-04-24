# Schema — SINASC (Nascidos Vivos)

**Status**: 🟡 planejado — schema doc como referência para contribuintes
que implementem `scripts/archive-sinasc.ts`.

**Fonte oficial**: [Dicionário de dados SINASC](https://opendatasus.saude.gov.br/dataset/sinasc),
arquivo "Layout DN.pdf" ou equivalente.

**Schema vintage**: DN 1996+ (nacional com DN mínima), com revisão 2011
que expandiu campos (escolaridade materna categorizada, raça/cor, etc.).
Estrutura estável desde 2011.

## Partições

```
s3://datasus-parquet/sinasc/ano=YYYY/uf=XX/part.parquet
```

Grão = (UF, ano) — `DN{UF}{YYYY}.dbc` no FTP (anual, não mensal).

## Colunas principais (DN 2011+)

| Coluna       | Tipo    | Descrição                                                          |
| ------------ | ------- | ------------------------------------------------------------------ |
| `NUMERODN`   | VARCHAR | Número da Declaração de Nascido Vivo (identificador único)         |
| `CODESTAB`   | VARCHAR | CNES do estabelecimento de ocorrência (7 díg.)                     |
| `CODMUNNASC` | VARCHAR | Município de nascimento (IBGE 6 díg.)                              |
| `LOCNASC`    | VARCHAR | Local de nascimento (1=hospital, 2=outro saúde, 3=domicílio, etc.) |
| `IDADEMAE`   | NUMERIC | Idade da mãe (anos)                                                |
| `ESTCIVMAE`  | VARCHAR | Estado civil da mãe                                                |
| `ESCMAE`     | VARCHAR | Escolaridade da mãe (1=nenhuma, 2=1-3a, 3=4-7a, 4=8-11a, 5=12+)    |
| `ESCMAE2010` | VARCHAR | Escolaridade DN 2011 (0=nenhuma, 1=fundam I, ..., 9=ignorado)      |
| `OCUPAOMAE`  | VARCHAR | Ocupação da mãe (CBO)                                              |
| `QTDFILVIVO` | NUMERIC | Quantidade de filhos vivos                                         |
| `QTDFILMORT` | NUMERIC | Quantidade de filhos mortos                                        |
| `CODMUNRES`  | VARCHAR | Município de residência da mãe (IBGE 6 díg.)                       |
| `GESTACAO`   | VARCHAR | Semanas de gestação (código categorizado 1–6)                      |
| `SEMAGESTAC` | NUMERIC | Semanas de gestação (valor numérico, DN 2011+)                     |
| `GRAVIDEZ`   | VARCHAR | Tipo (1=única, 2=dupla, 3=tripla+)                                 |
| `PARTO`      | VARCHAR | Tipo de parto (1=vaginal, 2=cesáreo)                               |
| `CONSULTAS`  | VARCHAR | Consultas pré-natal (1=nenhuma, 2=1-3, 3=4-6, 4=7+)                |
| `CONSPRENAT` | NUMERIC | Consultas pré-natal (valor numérico, DN 2011+)                     |
| `DTNASC`     | VARCHAR | Data de nascimento (AAAAMMDD)                                      |
| `HORANASC`   | VARCHAR | Hora (HHMM)                                                        |
| `SEXO`       | VARCHAR | Sexo (0=ignorado, 1=M, 2=F)                                        |
| `APGAR1`     | NUMERIC | APGAR no 1º minuto (0–10)                                          |
| `APGAR5`     | NUMERIC | APGAR no 5º minuto (0–10)                                          |
| `RACACOR`    | VARCHAR | Raça/cor do bebê (1–5)                                             |
| `RACACORMAE` | VARCHAR | Raça/cor da mãe                                                    |
| `PESO`       | NUMERIC | Peso ao nascer (gramas)                                            |
| `IDANOMAL`   | VARCHAR | Anomalia congênita detectada (1=sim, 2=não, 9=ign)                 |
| `CODANOMAL`  | VARCHAR | Código CID-10 da anomalia (quando aplicável)                       |
| `DTCADASTRO` | VARCHAR | Data de cadastro                                                   |
| `DTRECEBIM`  | VARCHAR | Data de recebimento                                                |
| `DTRECORIGA` | VARCHAR | Data recebimento original                                          |
| `NATURALMAE` | VARCHAR | Naturalidade da mãe                                                |
| `CODMUNNATU` | VARCHAR | Município de naturalidade da mãe                                   |
| `CODUFNATU`  | VARCHAR | UF de naturalidade da mãe                                          |
| `DTNASCMAE`  | VARCHAR | Data de nascimento da mãe                                          |
| `IDADEPAI`   | NUMERIC | Idade do pai                                                       |
| `MESPRENAT`  | NUMERIC | Mês de início do pré-natal                                         |
| `TPMETESTIM` | VARCHAR | Método estimativa da idade gestacional                             |
| `TPAPRESENT` | VARCHAR | Tipo de apresentação (cefálica, pélvica, etc.)                     |
| `STTRABPART` | VARCHAR | Trabalho de parto induzido?                                        |
| `STCESPARTO` | VARCHAR | Cesárea antes do trabalho de parto?                                |
| `TPNASCASSI` | VARCHAR | Quem assistiu o parto                                              |
| `TPROBSON`   | VARCHAR | Grupo de Robson                                                    |

## Charset / encoding

CP850/Latin-1 — decoder converte pra UTF-8.

## Códigos de referência

- **IBGE município**: 6 dígitos
- **CNES** (`CODESTAB`): 7 dígitos
- **CID-10** (`CODANOMAL`): 4 dígitos alfanuméricos
- **CBO** (`OCUPAOMAE`): 6 dígitos

## Caveats

- **Sub-registro** pequeno (<5% nacional), maior em Norte/Nordeste.
  OpendataSUS publica fatores de correção por UF.
- Campos `ESCMAE` (antigo) e `ESCMAE2010` (novo) coexistem em alguns
  vintages — análises longitudinais precisam harmonizar.
- `SEMAGESTAC` e `CONSPRENAT` (numéricos) são DN 2011+; vintages
  anteriores só têm a versão categorizada.

## Use cases típicos

- Taxa de prematuridade (peso < 2500g ou semanas < 37) × UF × ano
- Taxa de cesárea — indicador da OMS (meta < 15%)
- APGAR baixo como proxy de qualidade perinatal
- Pré-natal adequado (≥ 7 consultas) × raça/cor da mãe

## Referências

- [SINASC — Manuais](http://svs.aids.gov.br/dantps/centrais-de-conteudos/publicacoes/)
- [TabNet SINASC](http://tabnet.datasus.gov.br/cgi/tabcgi.exe?sinasc/cnv/nvuf.def)
- [OpenDataSUS SINASC](https://opendatasus.saude.gov.br/dataset/sinasc)
