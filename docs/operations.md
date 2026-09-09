# Operações — como publicar dados

Dois workflows publicam Parquet. **Escolher o errado custa horas**, então
comece por aqui.

|                            | `refresh.yml`                                                  | `backfill.yml`                                                                    |
| -------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Para que serve             | delta semanal (o que o DATASUS publicou desde a última rodada) | recuperar volume grande: meses/anos atrasados, re-arquivar competência corrompida |
| Gatilho                    | cron segunda 06:00 UTC + `workflow_dispatch`                   | só `workflow_dispatch`                                                            |
| Onde roda                  | runner do GitHub (`ubuntu-latest`)                             | **`rafael-desktop-archive`** (self-hosted, label `archive`)                       |
| Teto de tempo              | **180 min**                                                    | **1440 min (24h)**                                                                |
| Escopo                     | tudo que o `detect-new` achar pendente                         | você escolhe `ufs` × `years` × `months`                                           |
| Resiliência                | nenhuma — job morre, perde tudo                                | watchdog reinicia partição travada                                                |
| Reconstrói `manifest.json` | sim, com guarda anti-regressão                                 | **não**                                                                           |

## Regra prática

Rode `detect-new` (ou olhe o job `detect` do último refresh) e conte as
pendências:

- **até ~20 partições** → `refresh.yml` dá conta.
- **acima disso** → `backfill.yml`, em chunks.

Para dimensionar: 108 partições (4 meses × 27 UFs) **estouraram os 180
minutos do refresh sem publicar nada**. Ver "O que um timeout preserva".

## `refresh.yml` — delta semanal

```bash
gh workflow run refresh.yml --repo Precisa-Saude/datasus-parquet
```

Ordem dos passos: `detect-new` → archive de **todas** as pendências →
provenance → S3 sync → rebuild do `manifest.json` a partir da listagem do
bucket → guarda anti-regressão → invalidação do CloudFront →
`--mark-processed` → commit do state → GitHub Release (dispara o webhook
do Zenodo e **emite DOI**).

> O DOI é permanente. Não dispare "só pra testar".

## `backfill.yml` — volume grande, em chunks

```bash
gh workflow run backfill.yml --repo Precisa-Saude/datasus-parquet \
  -F ufs=ALL -F years=2026 -F months=03,04,05,06 \
  -F throttleMs=100 -F markProcessed=true -F invalidateCloudFront=true
```

Entradas: `ufs` (lista ou `ALL`), `years` (`2026`, `2022,2023`,
`2022-2025`), `months` (`ALL` ou `03,04`), `throttleMs`, `yearPauseMs`,
`markProcessed`, `invalidateCloudFront`.

**Separe SP, MG e RJ.** São os maiores e, de 2021 em diante, vêm em split
files no FTP; historicamente ficaram para o fim de cada backfill (ver as
tabelas de cobertura em `docs/development/PLAN.md`, onde aparecem
repetidamente como `🟡 falta SP/RJ/MG`). Um chunk típico:

```bash
# 1) o resto do país
gh workflow run backfill.yml -F ufs=AC,AL,AM,AP,BA,CE,DF,ES,GO,MA,MS,MT,PA,PB,PE,PI,PR,RN,RO,RR,RS,SC,SE,TO \
  -F years=2026 -F months=03,04,05,06

# 2) os pesados, um run só pra eles
gh workflow run backfill.yml -F ufs=SP,MG,RJ -F years=2026 -F months=03,04,05,06
```

É **idempotente**: o archive pula partição que já tem `part.parquet`, então
repetir um chunk que falhou no meio só refaz o que falta.

### Depois de um backfill: rode o refresh

`backfill.yml` **não reconstrói o `manifest.json`** — sobe os Parquet,
atualiza o state e invalida o CloudFront, só isso. O catálogo público
continua sem as partições novas até que um `refresh.yml` rode (no
dispatch seguinte ou no cron de segunda).

## O que um timeout preserva

**Nada.** Vale entender por quê, porque a intuição engana.

O `archive-sia-pa` grava em `build/` no disco do runner, e o `aws s3 sync`
só roda **depois** que todas as partições terminam. Não há `actions/cache`
em nenhum dos dois workflows. Se o job é cancelado no meio:

- nada foi para o S3;
- nada foi marcado como processado;
- o runner é destruído e o `build/` vai junto.

O state **não corrompe** — desde o PR #36 o `--mark-processed` só promove
competência que tenha Parquet real em `build/` —, mas também não houve
progresso. A próxima rodada recomeça do zero.

No runner self-hosted o `build/` sobrevive entre runs, e é por isso que o
backfill em chunks funciona: cada chunk aproveita o que o anterior deixou.

## Watchdog (só no backfill)

`scripts/archive-watchdog.sh` embrulha o archive porque o decoder de DBC
às vezes entra em loop de CPU sem yield:

- polla a cada 60s procurando `part.ndjson` com 0 byte e mtime > **15 min**
  (o limiar é 15 e não 5 porque SP/MG/RJ levam minutos só para baixar);
- ao detectar, mata o archive, apaga o DBC do cache e reinicia — o arquivo
  é rebaixado do FTP;
- se o mesmo DBC travar **2 vezes**, move para `.bad`, registra em
  `/tmp/archive-skipped.log` e segue adiante, em vez de travar o run.

O resumo do job conta `part.parquet`, `.skipped` e `.bad`. Qualquer
`.skipped` ou `.bad` merece olhar o log no runner.

## Verificação depois de publicar

```bash
# a competência chegou ao bucket?
curl -sI https://dfdu08vi8wsus.cloudfront.net/sia-pa/ano=2026/uf=SP/mes=03/part.parquet | head -1

# o que o state acha que está processado
git show origin/main:state/sia-pa.json | python3 -c "import json,sys; s=json.load(sys.stdin)['processed']; print(max(s['SP']))"

# quantas pendências sobraram
gh run view <run-id> --repo Precisa-Saude/datasus-parquet --log --job <detect-job-id> | grep pendentes
```

O state e o bucket precisam concordar. Divergência já aconteceu: em
2026-08 o state alegava cobertura até 2026-06 com o bucket parado em
2026-02, porque o archive rodava com os defaults `--ufs AC --years 2024` e
o `--mark-processed` marcava tudo assim mesmo (PR #36).

## Consumidor a jusante

`datasus-viz` tem o **próprio** `refresh.yml` (segunda 08:00 UTC, 2h depois
deste) que lê o `sia-pa/` publicado aqui e gera os agregados do site. Dado
novo só aparece no site depois que aquele workflow roda.
