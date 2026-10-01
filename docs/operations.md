# Operações — como publicar dados

Dois workflows publicam Parquet. **Escolher o errado custa horas**, então
comece por aqui.

|                            | `refresh.yml`                                                  | `backfill.yml`                                                                    |
| -------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Para que serve             | publicação mensal do DATASUS: janela revisável inteira + delta | recuperar volume grande: meses/anos atrasados, re-arquivar competência corrompida |
| Gatilho                    | cron segunda 06:00 UTC + `workflow_dispatch`                   | só `workflow_dispatch`                                                            |
| Onde roda                  | detect no GitHub; archive no **`rafael-desktop-archive`**      | **`rafael-desktop-archive`** (self-hosted, label `archive`)                       |
| Teto de tempo              | **1440 min (24h)** no archive                                  | **1440 min (24h)**                                                                |
| Escopo                     | janela de 13 competências × 27 UFs quando há publicação nova   | você escolhe `ufs` × `years` × `months`                                           |
| Resiliência                | watchdog + verificação contra o FTP antes do upload            | watchdog reinicia partição travada                                                |
| Reconstrói `manifest.json` | sim, com guarda anti-regressão                                 | **não**                                                                           |

## Regra prática

- **Publicação mensal do DATASUS** → `refresh.yml` (automático, segunda).
  Reprocessa a janela revisável inteira sem acompanhamento.
- **Recuperar o que está fora da janela** (anos antigos, partição que a
  auditoria apontou) → `backfill.yml`, em chunks.

## `refresh.yml` — publicação mensal (#46)

```bash
gh workflow run refresh.yml --repo Precisa-Saude/datasus-parquet
```

### Janela revisável

Pelas datas dos arquivos no FTP, cada publicação mensal do DATASUS reescreve
a competência mais recente **e as 12 anteriores**; depois disso a
competência deixa de mudar. Por isso o `detect-new -- --window 13`:

- sem nenhum delta contra o state (tamanho ou mtime) → nada pendente, o run
  é no-op;
- com qualquer delta → entram **todas** as partições da janela (13 × 27 ≈
  350), além do delta fora dela. Cada entrada do `pending.json` traz o
  `reason`: `novo`, `alterado` ou `janela`.

Custo: julho/2026 (27 partições) levou ~40 min no runner; a janela inteira,
8–10 h, uma vez por mês.

### Passos

1. `detect-new --window 13` no runner do GitHub.
2. No runner self-hosted, archive sob o watchdog com `--order newest-first`
   (a competência nova primeiro, para que uma falha no meio publique pelo
   menos o mês novo), num diretório próprio do run, `build-refresh/`. O
   `build/` do runner guarda partições de backfills antigos, e o
   `aws s3 sync` sobe qualquer arquivo de tamanho diferente — inclusive um
   mais velho que o do S3.
3. `verify-partitions`: compara as linhas de cada parquet com o
   `recordCount` dos cabeçalhos dos DBCs **lidos direto do FTP** (12 bytes,
   nunca do cache). Divergente, sem parquet ou ilegível vai para
   `build-rejected/` e não é publicado.
4. Provenance → S3 sync (só `build-refresh/`) → rebuild do `manifest.json`
   → guarda anti-regressão → invalidação do CloudFront (incluindo
   `/sia-pa/*`, porque a janela reescreve objetos existentes).
5. `--mark-processed --verified`: o state só recebe o que passou na
   verificação; o resto segue pendente para o próximo refresh.
6. Commit do state → GitHub Release (dispara o webhook do Zenodo e **emite
   DOI**) → dispara o `refresh.yml` do datasus-viz.
7. Se alguma partição foi rejeitada, o job termina em falha depois de
   publicar as aprovadas.

> O DOI é permanente. Não dispare "só pra testar".

## `audit.yml` — auditoria mensal

Todo dia 25 (e sob demanda), `pnpm audit-partitions` compara cada partição
do S3 (linhas no footer do parquet, sem baixar) com o `recordCount` dos
cabeçalhos no FTP (12 bytes por DBC). Havendo divergência, abre uma issue
com a label `audit` — ou comenta na que já estiver aberta. O conserto de uma
divergência fora da janela é um `backfill.yml` escopado.

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

### Depois de um backfill: rode o refresh com `forceManifest`

`backfill.yml` **não reconstrói o `manifest.json`** — sobe os Parquet,
atualiza o state e invalida o CloudFront, só isso. O catálogo público
continua sem as partições novas.

E um `refresh.yml` comum **não resolve**: depois que o backfill marcou o
state, o `detect-new` não acha nada pendente, o job `archive` é pulado
inteiro — e é lá dentro que o manifest é reconstruído. Use:

```bash
gh workflow run refresh.yml --repo Precisa-Saude/datasus-parquet -F forceManifest=true
```

> **Este modo não processa dado nenhum.** Ele só reescreve o catálogo a
> partir do que já está no bucket. Se a intenção era ingerir competência
> nova, o caminho é `refresh.yml` sem flag (delta) ou `backfill.yml`
> (volume) — ver a tabela no topo.

Rodam só os passos de catálogo: listar bucket → build manifest → guarda
anti-regressão → upload → invalidação.

O que ele **não** faz, e por quê:

- **não arquiva nem sobe Parquet** — não há delta; o `build/` sequer
  existe, e o `aws s3 sync build/` do passo de delta falharia. O
  `build-manifest` em modo `--s3-listing` monta o catálogo a partir da
  listagem do bucket e cria o diretório de saída sozinho, então não
  depende do `build/`.
- **não mexe no state** — nada foi ingerido nesta rodada.
- **não cria release nem emite DOI.** É deliberado: DOI é permanente e
  versiona _dado_, não catálogo. Um rebuild não acrescenta competência
  nenhuma, então não há o que versionar — e `latestCompetencia` viria
  vazio, gerando uma tag `dataset-`.

  Isso **não** impede o lote de um backfill de ter DOI: basta criar a
  release à mão, com tag e descrição próprias para aquele lote. O que o
  modo evita é emitir DOI automático e permanente para algo que não é
  versão nova do dado. Sem release manual, o lote entra no DOI da
  próxima competência nova.

A guarda anti-regressão continua ativa: um manifest que cobrisse menos
partições que o publicado é rejeitado antes do upload.

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
O refresh, ao contrário, começa cada run com um `build-refresh/` vazio:
como a janela reescreve partições que já existem, reaproveitar um parquet
de um run anterior significaria publicar a versão velha.

## Verificação do DBC antes de decodificar

O cache de download do SDK (`~/.cache/datasus-brasil/`) reusa o arquivo
pelo caminho, sem conferir se ainda bate com o FTP. Por isso o
`archive-sia-pa` lista o diretório do FTP uma vez no início do run e, para
cada partição:

- resolve canônico ou variantes `a`–`e` pela listagem (sem sondar 550);
- baixa todos os arquivos da partição e confere o tamanho de cada um contra
  a listagem **antes** de decodificar o primeiro;
- se o tamanho divergir (cópia antiga de um arquivo republicado ou download
  truncado), força um download novo; se ainda divergir, o erro entra no
  retry de transporte e, esgotado, a partição vira `.failed`.

Antes dessa checagem (issue #43), o pipeline chegou a republicar dados
antigos depois de uma republicação do DATASUS, a misturar variantes de
versões diferentes no mesmo mês e a travar horas decodificando um DBC
truncado.

## Watchdog

`scripts/archive-watchdog.sh` embrulha o archive porque o decoder de DBC
às vezes entra em loop de CPU sem yield. O `backfill.yml` sempre o usa; em
rodadas locais, use `pnpm archive:watch -- <args do archive>` em vez de
chamar o archive direto. Funciona no runner (Linux) e no macOS.

- polla a cada 60s procurando `part.ndjson` com 0 byte e mtime > **15 min**
  (o limiar é 15 e não 5 porque SP/MG/RJ levam minutos só para baixar);
- trata como stall também o log do archive sem linha nova há mais de
  **45 min** (`WATCHDOG_LOG_STALL_MIN`);
- ao detectar, mata o archive, apaga do cache os DBCs da partição (canônico
  e variantes) e reinicia — os arquivos são rebaixados do FTP;
- se a mesma partição travar **2 vezes**, move os DBCs para `.bad`,
  registra em `/tmp/archive-skipped.log` e segue adiante;
- desiste com exit 1 depois de **5** saídas não-zero seguidas do archive
  (`WATCHDOG_MAX_EXIT_RESTARTS`), em vez de reiniciar para sempre um erro
  determinístico;
- respeita `--out`, vigiando o diretório de saída que o archive usa.

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
