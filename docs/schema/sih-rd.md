# Schema — SIH-RD (AIH Reduzida)

**Status**: 🟡 planejado — schema doc como referência para contribuintes
que implementem `scripts/archive-sih-rd.ts`.

**Fonte oficial**: [Dicionário de dados SIH-RD](https://datasus.saude.gov.br/transferencia-de-arquivos/),
arquivo "Layout AIH-RD.pdf" ou equivalente.

**Schema vintage**: SIH-RD 2008+ (layout estabelecido em jan/2008). Há
ajustes graduais (novos campos em anos específicos) — cada `part.parquet`
preserva o schema do DBF fonte; confira o `part.provenance.json` da
partição.

## Partições

```
s3://datasus-parquet/sih-rd/ano=YYYY/uf=XX/mes=MM/part.parquet
```

Grão = (UF, ano, mês) — `RD{UF}{YYMM}.dbc` no FTP, mesmo esquema do SIA-PA.

## Colunas principais (presentes em praticamente todas as vintages)

| Coluna       | Tipo    | Descrição                                                       |
| ------------ | ------- | --------------------------------------------------------------- |
| `N_AIH`      | VARCHAR | Número da AIH (13 díg., identificador único da internação)      |
| `UF_ZI`      | VARCHAR | Zona de identificação (UF + código) — 6 díg.                    |
| `ANO_CMPT`   | NUMERIC | Ano de competência                                              |
| `MES_CMPT`   | NUMERIC | Mês de competência (1–12)                                       |
| `CNES`       | VARCHAR | CNES do estabelecimento de internação (7 díg.)                  |
| `MUNIC_MOV`  | VARCHAR | Código IBGE do município do estabelecimento (6 díg.)            |
| `MUNIC_RES`  | VARCHAR | Código IBGE do município de residência do paciente (6 díg.)     |
| `NASC`       | VARCHAR | Data de nascimento (AAAAMMDD)                                   |
| `IDADE`      | NUMERIC | Idade (valor)                                                   |
| `COD_IDADE`  | VARCHAR | Unidade da idade (0=horas, 1=dias, 2=meses, 3=anos, 4=centenas) |
| `SEXO`       | VARCHAR | Sexo (1=M, 3=F)                                                 |
| `RACA_COR`   | VARCHAR | Raça/cor (1–5, 99)                                              |
| `ETNIA`      | VARCHAR | Etnia indígena                                                  |
| `DT_INTER`   | VARCHAR | Data de internação (AAAAMMDD)                                   |
| `DT_SAIDA`   | VARCHAR | Data de saída (AAAAMMDD)                                        |
| `DIAS_PERM`  | NUMERIC | Dias de permanência                                             |
| `MORTE`      | VARCHAR | Indicador de óbito (0/1)                                        |
| `DIAG_PRINC` | VARCHAR | CID-10 principal                                                |
| `DIAG_SECUN` | VARCHAR | CID-10 secundário                                               |
| `CID_ASSO`   | VARCHAR | CID-10 associado (vintages recentes)                            |
| `CID_MORTE`  | VARCHAR | CID-10 de morte (quando aplicável)                              |
| `CID_NOTIF`  | VARCHAR | CID-10 de notificação (quando aplicável)                        |
| `PROC_SOLIC` | VARCHAR | Procedimento solicitado (SIGTAP)                                |
| `PROC_REA`   | VARCHAR | Procedimento realizado (SIGTAP principal)                       |
| `VAL_SH`     | NUMERIC | Valor serviços hospitalares                                     |
| `VAL_SP`     | NUMERIC | Valor serviços profissionais                                    |
| `VAL_TOT`    | NUMERIC | Valor total da AIH (em centavos)                                |
| `VAL_UTI`    | NUMERIC | Valor de UTI                                                    |
| `UTI_MES_IN` | NUMERIC | UTI — dias no mês de início                                     |
| `UTI_MES_AN` | NUMERIC | UTI — dias no mês anterior                                      |
| `DIAR_ACOM`  | NUMERIC | Diárias de acompanhante                                         |
| `QT_DIARIAS` | NUMERIC | Quantidade de diárias                                           |
| `CAR_INT`    | VARCHAR | Caráter de internação (1=eletivo, 2=urgência, etc.)             |
| `INSTRU`     | VARCHAR | Instrução (escolaridade) — vintages recentes                    |
| `GESTANTE`   | VARCHAR | Indicador de gestante                                           |
| `GESTRISCO`  | VARCHAR | Gestação de risco                                               |
| `CBOR`       | VARCHAR | CBO do responsável pela AIH                                     |
| `CNAER`      | VARCHAR | CNAE atividade econômica (quando acidente de trabalho)          |
| `VINCPREV`   | VARCHAR | Vínculo previdenciário                                          |
| `GESTOR_COD` | VARCHAR | Código do gestor que autorizou                                  |
| `CNPJ_MANT`  | VARCHAR | CNPJ mantenedora                                                |
| `TOT_PT_SP`  | NUMERIC | Total de pontos de serviço profissional                         |

## Charset / encoding

CP850/Latin-1 nos campos de texto — decoder converte pra UTF-8 na leitura
(mesma transformação de SIA-PA).

## Códigos de referência

- **IBGE município** (`MUNIC_MOV`, `MUNIC_RES`): 6 dígitos
- **SIGTAP** (`PROC_REA`, `PROC_SOLIC`): 10 dígitos — http://sigtap.datasus.gov.br
- **CNES** (`CNES`): 7 dígitos
- **CID-10** (`DIAG_*`, `CID_*`): notação OMS
- **CBO** (`CBOR`): 6 dígitos

## Use cases típicos

- Mortalidade hospitalar por procedimento, UF, faixa etária
- Gasto público com internações (via `VAL_TOT`)
- Distribuição geográfica de procedimentos cirúrgicos de alta complexidade
- Epidemiologia de internações por CID-10

## Referências

- [Nota Técnica SIH-SUS](http://sihd.datasus.gov.br)
- [TabNet SIH](http://tabnet.datasus.gov.br/cgi/tabcgi.exe?sih/cnv/niuf.def)
- Caveat: SIH-SP (Serviços Profissionais) é subdataset separado não coberto
  aqui — contém detalhamento por profissional.
