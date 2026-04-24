# Schema — SIA-PA (Produção Ambulatorial)

**Fonte oficial**: [Dicionário de dados SIA-PA](https://datasus.saude.gov.br/transferencia-de-arquivos/),
arquivo "LAYOUT PA.pdf" ou equivalente na documentação do SIA-SUS.

**Schema vintage**: SIA-PA 2008+ (layout atual estabelecido em jul/2008).

> Nota: o schema **varia ligeiramente entre competências**. Colunas
> novas são adicionadas em vintages específicas (ex.: `PA_RACACOR` a
> partir de 2013, `PA_SRV_C` posteriormente). Cada `part.parquet` preserva
> o schema exato do DBF fonte — confira o `provenance/.../part.provenance.json`
> para a lista canônica de colunas daquela partição.

## Colunas principais (presentes em praticamente todas as vintages)

| Coluna         | Tipo      | Descrição                                                          |
| -------------- | --------- | ------------------------------------------------------------------ |
| `PA_CODUNI`    | VARCHAR   | CNES (Cadastro Nacional de Estabelecimentos) do prestador (7 díg.) |
| `PA_GESTAO`    | VARCHAR   | Código IBGE do município gestor (6 díg.)                           |
| `PA_CONDIC`    | VARCHAR   | Condição de gestão (E/M/D — Estadual/Municipal/Dupla)              |
| `PA_UFMUN`     | VARCHAR   | Código IBGE do município do prestador (6 díg., sem DV)             |
| `PA_REGCT`     | VARCHAR   | Código de região                                                   |
| `PA_INCOUT`    | VARCHAR   | Incremento outros                                                  |
| `PA_INCURG`    | VARCHAR   | Incremento urgência                                                |
| `PA_TPUPS`     | VARCHAR   | Tipo de estabelecimento (CNES)                                     |
| `PA_TIPPRE`    | VARCHAR   | Tipo de prestador                                                  |
| `PA_MN_IND`    | VARCHAR   | Mantenedora (M) ou individual (I)                                  |
| `PA_CNPJCPF`   | VARCHAR   | CNPJ/CPF do estabelecimento                                        |
| `PA_CNPJMNT`   | VARCHAR   | CNPJ da mantenedora                                                |
| `PA_CNPJ_CC`   | VARCHAR   | CNPJ do cartão convênio                                            |
| `PA_MVM`       | VARCHAR   | Ano/mês do movimento (AAAAMM)                                      |
| `PA_CMP`       | VARCHAR   | Competência (AAAAMM)                                               |
| `PA_PROC_ID`   | VARCHAR   | Código SIGTAP do procedimento (10 díg.)                            |
| `PA_TPFIN`     | VARCHAR   | Tipo de financiamento                                              |
| `PA_SUBFIN`    | VARCHAR   | Subtipo de financiamento                                           |
| `PA_NIVCPL`    | VARCHAR   | Complexidade                                                       |
| `PA_DOCORIG`   | VARCHAR   | Documento de origem (BPA, APAC, etc.)                              |
| `PA_AUTORIZ`   | VARCHAR   | Número da autorização                                              |
| `PA_CNSMED`    | VARCHAR   | CNS do profissional executante                                     |
| `PA_CBOCOD`    | VARCHAR   | CBO (Classificação Brasileira de Ocupações) do executante          |
| `PA_MOTSAI`    | VARCHAR   | Motivo de saída / permanência                                      |
| `PA_OBITO`     | VARCHAR   | Indicador de óbito (0/1)                                           |
| `PA_ENCERR`    | VARCHAR   | Encerramento                                                       |
| `PA_PERMAN`    | VARCHAR   | Permanência                                                        |
| `PA_ALTA`      | VARCHAR   | Alta                                                               |
| `PA_TRANSF`    | VARCHAR   | Transferência                                                      |
| `PA_CIDPRI`    | VARCHAR   | CID-10 principal                                                   |
| `PA_CIDSEC`    | VARCHAR   | CID-10 secundário                                                  |
| `PA_CIDCAS`    | VARCHAR   | CID-10 causas                                                      |
| `PA_CATEND`    | VARCHAR   | Caráter de atendimento                                             |
| `PA_IDADE`     | NUMERIC   | Idade (valor)                                                      |
| `IDADEMIN`     | NUMERIC   | Idade mínima do procedimento                                       |
| `IDADEMAX`     | NUMERIC   | Idade máxima do procedimento                                       |
| `PA_FLIDADE`   | VARCHAR   | Flag idade compatível                                              |
| `PA_SEXO`      | VARCHAR   | Sexo (M/F/I)                                                       |
| `PA_RACACOR`   | VARCHAR   | Raça/cor (1–5, 99) — desde 2013                                    |
| `PA_MUNPCN`    | VARCHAR   | Município de residência do paciente (6 díg.)                       |
| `PA_QTDPRO`    | NUMERIC   | Quantidade produzida                                               |
| `PA_QTDAPR`    | NUMERIC   | Quantidade aprovada                                                |
| `PA_VALPRO`    | NUMERIC   | Valor produzido (em centavos)                                      |
| `PA_VALAPR`    | NUMERIC   | Valor aprovado (em centavos)                                       |
| `PA_UFDIF`     | VARCHAR   | Diferença UF executante / residência                               |
| `PA_MNDIF`     | VARCHAR   | Diferença município executante / residência                        |
| `PA_DIF_VAL`   | NUMERIC   | Diferença de valor                                                 |
| `NU_VPATA`     | NUMERIC   | Valor pago                                                         |
| `NU_PA_TOT`    | NUMERIC   | Total                                                              |
| `PA_INDICA`    | VARCHAR   | Indicação                                                          |
| `PA_CODOCO`    | VARCHAR   | Código ocorrência                                                  |
| `PA_FLQT`      | VARCHAR   | Flag quantidade compatível                                         |
| `PA_FLER`      | VARCHAR   | Flag erro                                                          |
| `PA_ETNIA`     | VARCHAR   | Etnia indígena                                                     |
| `PA_VL_CF`     | NUMERIC   | Valor complemento federal                                          |
| `PA_VL_CL`     | NUMERIC   | Valor complemento local                                            |
| `PA_VL_INC`    | NUMERIC   | Valor incentivo                                                    |
| `PA_SRV_C`     | VARCHAR   | Serviço classificado (vintages recentes)                           |
| `PA_INE`       | VARCHAR   | Código INE                                                         |
| `PA_NAT_JUR`   | VARCHAR   | Natureza jurídica                                                  |

## Charset / encoding

DBF do SIA usa CP850/Latin-1 em campos texto com acentuação. O
decoder (`@precisa-saude/datasus-dbc`) converte para UTF-8 na leitura
— esta é a única transformação que o pipeline aplica. Strings
preservam o conteúdo byte-significativo, apenas re-encodadas.

## Códigos de referência

- **IBGE município** (`PA_UFMUN`, `PA_MUNPCN`, `PA_GESTAO`): 6 dígitos
  (sem dígito verificador). Para casar com a tabela IBGE de 7 dígitos,
  use os primeiros 6 dígitos do código IBGE completo.
- **SIGTAP** (`PA_PROC_ID`): 10 dígitos — tabela procedimentos,
  medicamentos, OPM e materiais (ex.: `02.02.01.007-0` em formato humano).
  Referência: http://sigtap.datasus.gov.br
- **CNES** (`PA_CODUNI`): 7 dígitos. Cruzar com dataset CNES-ST
  quando/se publicado.
- **CBO** (`PA_CBOCOD`): Classificação Brasileira de Ocupações, 6 dígitos.
- **CID-10** (`PA_CIDPRI`, `PA_CIDSEC`, `PA_CIDCAS`): notação OMS, 4
  dígitos alfanuméricos (ex.: `E119`).

## Referências

- Nota Técnica SIA-SUS (DATASUS): instruções de uso dos microdados
- Portaria MS nº 896/2017 (tabela SIGTAP)
- [TabNet SIA](http://tabnet.datasus.gov.br/cgi/tabcgi.exe?sia/cnv/qauf.def)
  — UI oficial de tabulação
