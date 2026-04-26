#!/bin/bash
# Watchdog wrapper for archive-sia-pa.
#
# Detects partições travadas (DBC decoder em loop CPU sem yield) e
# corrige automaticamente:
#   1. polla a cada 60s procurando `part.ndjson` com size=0 e mtime>5min
#   2. quando acha, mata archive (-9) → deleta DBC corrompido do cache
#      → reinicia archive (que re-baixa fresco do FTP)
#   3. se o mesmo DBC corromper 2x consecutivas, move pra `.bad` e
#      registra em /tmp/archive-skipped.log — não fica em loop infinito
#
# Uso: bash scripts/archive-watchdog.sh [--years YYYY[,YYYY-YYYY]]

set -uo pipefail

CACHE_DIR=$HOME/.cache/datasus-brasil/dissemin/publicos/SIASUS/200801_/Dados
# REPO_DIR padrão é o diretório do script (pra funcionar em worktrees);
# pode ser sobrescrito via env DATASUS_REPO_DIR.
REPO_DIR="${DATASUS_REPO_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
BUILD_DIR=$REPO_DIR/build/sia-pa
# Caminhos de log/estado podem ser sobrescritos via env (útil quando duas
# instâncias do watchdog rodam em paralelo, ex: transform + FTP-backfill).
ARCHIVE_LOG="${WATCHDOG_ARCHIVE_LOG:-/tmp/archive-run-watchdog.log}"
WATCHDOG_LOG="${WATCHDOG_META_LOG:-/tmp/archive-watchdog.log}"
SKIPPED_LOG="${WATCHDOG_SKIPPED_LOG:-/tmp/archive-skipped.log}"
STALL_THRESHOLD_MIN=5
MAX_RETRIES=2

# Args do archive-sia-pa: tudo passado via "$@" é repassado pro pnpm
# archive-sia-pa --. Default cobre o caso comum.
if [ $# -eq 0 ]; then
  ARCHIVE_ARGS=(--ufs ALL --years 2008,2020-2025 --throttle-ms 100 --year-pause-ms 0)
else
  ARCHIVE_ARGS=("$@")
fi

# Map DBC path → tentativas. Usa arquivo em vez de assoc array pra
# sobreviver entre invocações se quiser dar resume manual.
RETRIES_FILE="${WATCHDOG_RETRIES_FILE:-/tmp/archive-watchdog-retries}"
touch "$RETRIES_FILE"
touch "$SKIPPED_LOG"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$WATCHDOG_LOG"
}

retry_count() {
  # grep -c imprime "0" e sai com 1 quando não há matches — `|| echo 0` ali
  # produzia "0\n0" e quebrava a comparação `[ "$n" -ge "$MAX_RETRIES" ]`.
  local n
  n=$(grep -c "^$1$" "$RETRIES_FILE" 2>/dev/null)
  echo "${n:-0}"
}

bump_retry() {
  echo "$1" >> "$RETRIES_FILE"
}

# SIGKILL recursivo no tree de descendentes de $1 (DFS post-order). pnpm/tsx
# não propagam sinais para o node filho, então `kill -9 $pnpm_pid` deixa o
# worker vazando — todo restart por stall precisa do kill_tree.
kill_tree() {
  local pid=$1
  for child in $(pgrep -P "$pid" 2>/dev/null); do
    kill_tree "$child"
  done
  kill -9 "$pid" 2>/dev/null
}

start_archive() {
  cd "$REPO_DIR"
  NODE_OPTIONS="--max-old-space-size=8192" pnpm archive-sia-pa -- \
    "${ARCHIVE_ARGS[@]}" \
    > "$ARCHIVE_LOG" 2>&1 &
  # ARCHIVE_PID precisa ser variável global, não echo'd via $(start_archive),
  # pra que `wait $ARCHIVE_PID` no shell principal consiga capturar o exit
  # code real (subshell quebra a relação parent-child e `wait` retorna 127).
  ARCHIVE_PID=$!
}

log "===== Watchdog start (repo=$REPO_DIR, args=${ARCHIVE_ARGS[*]}, stall=${STALL_THRESHOLD_MIN}min, max_retries=$MAX_RETRIES) ====="

while true; do
  start_archive
  log "Started archive PID=$ARCHIVE_PID"

  STALLED_THIS_RUN=""
  while kill -0 "$ARCHIVE_PID" 2>/dev/null; do
    sleep 60

    # Find first 0-byte ndjson older than threshold
    STALLED=$(find "$BUILD_DIR" -name part.ndjson -size 0 -mmin +"$STALL_THRESHOLD_MIN" 2>/dev/null | head -1)
    [ -z "$STALLED" ] && continue

    # Parse partition path: build/sia-pa/ano=YYYY/uf=XX/mes=MM/part.ndjson
    ANO=$(echo "$STALLED" | grep -oE 'ano=[0-9]+' | cut -d= -f2)
    UF=$(echo "$STALLED" | grep -oE 'uf=[A-Z]+' | cut -d= -f2)
    MES=$(echo "$STALLED" | grep -oE 'mes=[0-9]+' | cut -d= -f2)
    YY=${ANO:2:2}
    DBC="$CACHE_DIR/PA${UF}${YY}${MES}.dbc"

    n=$(retry_count "$DBC")
    log "STALL: $UF $ANO-$MES (DBC=$DBC, retries=$n)"

    log "  killing archive tree PID=$ARCHIVE_PID (+ descendentes)"
    kill_tree "$ARCHIVE_PID"
    rm -f "$STALLED"

    if [ "$n" -ge "$MAX_RETRIES" ]; then
      log "  ABORT: $DBC corrompeu $n vezes — movendo pra .bad e marcando skip"
      [ -f "$DBC" ] && mv "$DBC" "$DBC.bad"
      echo "$(date '+%Y-%m-%d %H:%M:%S') $UF $ANO-$MES $DBC" >> "$SKIPPED_LOG"
      # Cria placeholder vazio pra archive não tentar processar de novo
      mkdir -p "$BUILD_DIR/ano=$ANO/uf=$UF/mes=$MES"
      touch "$BUILD_DIR/ano=$ANO/uf=$UF/mes=$MES/part.parquet.skipped"
    else
      log "  deletando cache corrompido pra forçar re-download"
      [ -f "$DBC" ] && rm -f "$DBC"
      bump_retry "$DBC"
    fi

    STALLED_THIS_RUN="yes"
    break
  done

  # Aguarda exit code só se não matamos manualmente
  if [ -z "$STALLED_THIS_RUN" ]; then
    wait "$ARCHIVE_PID" 2>/dev/null
    rc=$?
    if [ "$rc" -eq 0 ]; then
      log "Archive concluído com sucesso (exit 0)"
      break
    else
      log "Archive saiu com exit=$rc — reiniciando"
    fi
  else
    log "Reiniciando após stall handling"
  fi
  sleep 3
done

log "===== Watchdog done ====="
log "Skipped DBCs (após $MAX_RETRIES tentativas, ver $SKIPPED_LOG):"
cat "$SKIPPED_LOG" | tee -a "$WATCHDOG_LOG"
