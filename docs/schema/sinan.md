# Schema — SINAN (Agravos de Notificação)

**Status**: 🟡 planejado — schema doc como referência para contribuintes
que implementem `scripts/archive-sinan.ts`.

**Fonte oficial**: [Dicionário SINAN](https://portalsinan.saude.gov.br/),
documentação específica por agravo.

**Schema vintage**: SINAN NET 2007+ (versão atual). O SINAN tem
**schema por agravo** — cada doença/agravo tem seu próprio conjunto de
campos específicos além do núcleo comum (Ficha de Notificação). Cada
`part.parquet` preserva o schema DBF da vintage daquele arquivo.

## Partições

```
s3://datasus-parquet/sinan/agravo=XXX/ano=YYYY/part.parquet
```

Grão = (agravo, ano) — SINAN **não particiona por UF**. O arquivo FTP
é nacional: `{AGRAVO}BR{YY}.dbc` (ex.: `DENGBR23.dbc` = dengue 2023).

Use `SG_UF_NOT` (UF da notificação) ou `SG_UF` (UF de residência) para
filtrar por estado em query-time.

## Agravos cobertos

| Prefixo FTP | Agravo                               |
| ----------- | ------------------------------------ |
| `DENG`      | Dengue                               |
| `ZIKA`      | Zika                                 |
| `CHIK`      | Chikungunya                          |
| `FAMA`      | Febre amarela (casos e óbitos)       |
| `LEIV`      | Leishmaniose visceral                |
| `LEIT`      | Leishmaniose tegumentar              |
| `LEPT`      | Leptospirose                         |
| `HEPA`      | Hepatites virais                     |
| `MENI`      | Meningite                            |
| `TUBE`      | Tuberculose                          |
| `HANS`      | Hanseníase                           |
| `MALA`      | Malária                              |
| `AIDS`      | AIDS adulto/criança                  |
| `SIFILIS`   | Sífilis                              |
| `ACBI`      | Acidente biológico                   |
| `ANTR`      | Atendimento antirrábico humano       |
| `VIOL`      | Violência interpessoal/autoprovocada |
| `ESQUI`     | Esquistossomose                      |
| `COLE`      | Cólera                               |
| `BOTU`      | Botulismo                            |

## Colunas comuns (Ficha de Notificação — todos os agravos)

| Coluna       | Tipo    | Descrição                                              |
| ------------ | ------- | ------------------------------------------------------ |
| `TP_NOT`     | VARCHAR | Tipo de notificação (1=negativa, 2=individual)         |
| `ID_AGRAVO`  | VARCHAR | Código do agravo (CID-10 ou código SINAN)              |
| `DT_NOTIFIC` | VARCHAR | Data da notificação (AAAAMMDD)                         |
| `SEM_NOT`    | VARCHAR | Semana epidemiológica da notificação (AAAASS)          |
| `NU_ANO`     | VARCHAR | Ano da notificação                                     |
| `SG_UF_NOT`  | VARCHAR | UF da notificação (código IBGE 2 díg.)                 |
| `ID_MUNICIP` | VARCHAR | Município da notificação (IBGE 6 díg.)                 |
| `ID_REGIONA` | VARCHAR | Regional de saúde                                      |
| `ID_UNIDADE` | VARCHAR | CNES da unidade notificante                            |
| `DT_SIN_PRI` | VARCHAR | Data dos primeiros sintomas                            |
| `SEM_PRI`    | VARCHAR | Semana epidemiológica dos sintomas                     |
| `NU_IDADE_N` | VARCHAR | Idade (4 díg: 1º=unidade, 3 últimos=valor — igual SIM) |
| `CS_SEXO`    | VARCHAR | Sexo (M/F/I)                                           |
| `CS_GESTANT` | VARCHAR | Gestante (1=1º tri, 2=2º tri, 3=3º tri, 4=idade ign)   |
| `CS_RACA`    | VARCHAR | Raça/cor (1–5, 9)                                      |
| `CS_ESCOL_N` | VARCHAR | Escolaridade                                           |
| `SG_UF`      | VARCHAR | UF de residência (IBGE 2 díg.)                         |
| `ID_MN_RESI` | VARCHAR | Município de residência (IBGE 6 díg.)                  |
| `ID_RG_RESI` | VARCHAR | Regional de residência                                 |
| `ID_PAIS`    | VARCHAR | País de residência (código)                            |
| `DT_INVEST`  | VARCHAR | Data da investigação                                   |
| `ID_OCUPA_N` | VARCHAR | Ocupação (CBO)                                         |

## Campos específicos por agravo

Cada agravo adiciona campos próprios (sintomas, exames, tratamento,
evolução). Exemplos:

- **Dengue** (`DENG`): `FEBRE`, `MIALGIA`, `CEFALEIA`, `RES_CHIKS1`,
  `RESUL_NS1`, `SOROTIPO`, `CLASSI_FIN`, `CRITERIO`, `EVOLUCAO`
- **Tuberculose** (`TUBE`): `FORMA`, `AGRAVAIDS`, `AGRAVDIABE`,
  `AGRAVALCOO`, `BACILOSC_E`, `CULTURA_ES`, `HIV`, `RAIOX_TORA`,
  `TRATAMENTO`, `SITUA_ENCE`
- **HANS**: `FORMACLINI`, `CLASSOPERA`, `MODOENTRAD`, `ESQ_INI_N`,
  `AVAL_INI_N`

Consulte o dicionário específico de cada agravo em
https://portalsinan.saude.gov.br/doencas-e-agravos.

## Charset / encoding

CP850/Latin-1 — decoder converte pra UTF-8.

## Códigos de referência

- **CID-10** (`ID_AGRAVO` quando for código CID): 4 dígitos alfanuméricos
- **IBGE município**: 6 dígitos
- **CBO** (`ID_OCUPA_N`): 6 dígitos
- **CNES** (`ID_UNIDADE`): 7 dígitos

## Caveats

- **Heterogeneidade de schema**: campos específicos podem aparecer,
  desaparecer ou mudar de tipo entre vintages. Sempre consultar
  `part.provenance.json` antes de depender de um campo específico.
- **Duplicação entre estados**: quando um paciente é notificado e depois
  mora em outra UF, pode haver notificações em ambas. Regras de
  desduplicação são agravo-específicas.
- **Definição de caso**: `CRITERIO` e `CLASSI_FIN` determinam se o caso
  foi confirmado — filtrar antes de contar incidência.
- **Prefixo de arquivo (`{AGRAVO}BR`)** diferente do código do agravo em
  `ID_AGRAVO` (que pode ser CID-10 ou código SINAN). A partição
  `agravo=` no Parquet usa o prefixo FTP (4 letras).

## Use cases típicos

- Curvas epidêmicas semanais (arbovírus: dengue, zika, chikungunya)
- Taxa de cura / abandono em tuberculose e hanseníase
- Mapeamento de leishmaniose, malária, febre amarela
- Vigilância de violência interpessoal

## Referências

- [SINAN Portal](https://portalsinan.saude.gov.br/)
- [TabNet SINAN Dengue](http://tabnet.datasus.gov.br/cgi/tabcgi.exe?sinannet/cnv/denguebr.def)
- [Dicionários por agravo](https://portalsinan.saude.gov.br/doencas-e-agravos)
