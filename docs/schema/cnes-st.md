# Schema — CNES-ST (Cadastro de Estabelecimentos)

**Status**: 🟡 planejado — schema doc como referência para contribuintes
que implementem `scripts/archive-cnes-st.ts`.

**Fonte oficial**: [Layout CNES](https://cnes.datasus.gov.br/),
arquivo "Layout ST.pdf" ou equivalente.

**Schema vintage**: CNES-ST mensal 2005+ (após consolidação do sistema
atual). Estrutura do DBF evolui lentamente — adições ocasionais de campos
(ex.: CEP reformulado, classificação de vínculo SUS).

## Partições

```
s3://datasus-parquet/cnes-st/ano=YYYY/uf=XX/mes=MM/part.parquet
```

Grão = (UF, ano, mês) — `ST{UF}{YYMM}.dbc` no FTP (mensal, "snapshot"
do cadastro naquele mês).

O CNES tem múltiplos subdatasets (ST=estabelecimento, PF=profissional,
EQ=equipamentos, SR=serviço, LT=leitos, HB=habilitação, EP=especialidade,
IN=incentivos, DC=dados complementares...). Este doc cobre só ST;
outros subdatasets precisam de seus próprios schemas.

## Colunas principais

| Coluna       | Tipo    | Descrição                                                |
| ------------ | ------- | -------------------------------------------------------- |
| `CNES`       | VARCHAR | Código CNES (7 díg., identificador único)                |
| `CODUFMUN`   | VARCHAR | Código IBGE UF+município (6 díg.)                        |
| `REGSAUDE`   | VARCHAR | Região de saúde                                          |
| `MICR_REG`   | VARCHAR | Microrregião IBGE                                        |
| `DISTRSAN`   | VARCHAR | Distrito sanitário                                       |
| `DISTRADM`   | VARCHAR | Distrito administrativo                                  |
| `TPGESTAO`   | VARCHAR | Tipo de gestão (E=estadual, M=municipal, D=dupla)        |
| `PF_PJ`      | VARCHAR | Pessoa física (1) / jurídica (3)                         |
| `CPF_CNPJ`   | VARCHAR | CPF ou CNPJ                                              |
| `NIV_DEP`    | VARCHAR | Nível de dependência (1=individual, 3=mantido)           |
| `CNPJ_MAN`   | VARCHAR | CNPJ da mantenedora (quando NIV_DEP=3)                   |
| `COD_IR`     | VARCHAR | Código de IR                                             |
| `ESFERA_A`   | VARCHAR | Esfera administrativa                                    |
| `RETENCAO`   | VARCHAR | Retenção de tributos                                     |
| `ATIVIDAD`   | VARCHAR | Atividade principal                                      |
| `NATUREZA`   | VARCHAR | Natureza da organização                                  |
| `CLIENTEL`   | VARCHAR | Tipo de clientela (SUS, particular, convênio...)         |
| `TP_UNID`    | VARCHAR | Tipo de unidade (1=hospital, 2=UBS, ..., 40=laboratório) |
| `TURNO_AT`   | VARCHAR | Turno de atendimento                                     |
| `NIV_HIER`   | VARCHAR | Nível hierárquico                                        |
| `TERCEIRO`   | VARCHAR | Atende terceiros                                         |
| `CPF_DIREC`  | VARCHAR | CPF do diretor                                           |
| `COD_CEP`    | VARCHAR | CEP                                                      |
| `VINC_SUS`   | VARCHAR | Vinculado ao SUS (S/N)                                   |
| `TP_PREST`   | VARCHAR | Tipo de prestador (com/sem fins lucrativos, público...)  |
| `SGRUPHAB`   | VARCHAR | Subgrupo de habilitação                                  |
| `ESFERA_A`   | VARCHAR | Esfera administrativa                                    |
| `RSOC_MAN`   | VARCHAR | Razão social da mantenedora                              |
| `NO_FANTASI` | VARCHAR | Nome fantasia do estabelecimento                         |
| `LOGRADOUR`  | VARCHAR | Logradouro                                               |
| `ENDERECO`   | VARCHAR | Endereço                                                 |
| `NUMERO`     | VARCHAR | Número                                                   |
| `COMPLEMEN`  | VARCHAR | Complemento                                              |
| `BAIRRO`     | VARCHAR | Bairro                                                   |
| `TELEFONE`   | VARCHAR | Telefone                                                 |
| `FAX`        | VARCHAR | Fax                                                      |
| `EMAIL`      | VARCHAR | E-mail                                                   |
| `AP01CV01`   | VARCHAR | Flag atende plano 1 convênio 1 (sequência configurável)  |
| `...`        | ...     | Flags de planos/convênios (vários campos)                |
| `COMPETEN`   | VARCHAR | Competência (AAAAMM)                                     |
| `QTLEITP1`   | NUMERIC | Quantidade de leitos pediátricos tipo 1                  |
| `...`        | ...     | Contagem de leitos por tipo (dezenas de colunas `QT*`)   |
| `URGEMERG`   | VARCHAR | Atende urgência/emergência                               |
| `ATENDAMB`   | VARCHAR | Atendimento ambulatorial                                 |
| `ATENDHOS`   | VARCHAR | Atendimento hospitalar                                   |
| `ATENDODO`   | VARCHAR | Atendimento odontológico                                 |
| `ATENDSAD`   | VARCHAR | Atende Serviço de Atenção Domiciliar                     |

## Charset / encoding

CP850/Latin-1 — decoder converte pra UTF-8.

## Códigos de referência

- **CNES**: 7 dígitos, identificador único do estabelecimento
- **IBGE município** (`CODUFMUN`): 6 dígitos
- **CNPJ/CPF**: na estrutura do DBF sem formatação
- **Tipo de unidade** (`TP_UNID`): tabela DATASUS de ~50 tipos

## Caveats

- **Snapshot mensal**: o mesmo CNES aparece em todas as competências enquanto
  ativo. Para análises longitudinais ("quando uma UBS foi credenciada"),
  cruzar múltiplas competências.
- **Campos de endereço**: alguns vintages usam `ENDERECO` consolidado,
  outros dividem em `LOGRADOUR` + `NUMERO` + `COMPLEMEN`.
- **Duplicatas entre subdatasets**: CNES-ST é apenas o cadastro do
  estabelecimento; detalhes operacionais (leitos, especialidades,
  profissionais) estão em subdatasets separados que precisam ser
  juntados por `CNES`.
- **Baixa qualidade de nome fantasia** em alguns vintages (nomes
  truncados, siglas, inconsistências de maiúsculas).

## Use cases típicos

- Inventário nacional de estabelecimentos por tipo e UF
- Cobertura de atenção primária (UBS por 10k habitantes)
- Capacidade instalada (leitos por especialidade × município)
- Cruzar com SIA-PA (`PA_CODUNI`) / SIH-RD (`CNES`) pra nomear
  estabelecimentos em análises clínicas

## Referências

- [CNES Portal](https://cnes.datasus.gov.br/)
- [TabNet CNES](http://tabnet.datasus.gov.br/cgi/deftohtm.exe?cnes/cnv/estabbr.def)
- [Layout dos arquivos](ftp://ftp.datasus.gov.br/cnes/)
