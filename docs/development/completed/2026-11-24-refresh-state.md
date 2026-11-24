# Recuperação do state após publicação

## Objetivo

Corrigir o commit do state no refresh sem repetir o archive já publicado.

## Contexto

O run 45231634914 verificou 325 partições (zero rejeitadas), publicou 260
e reconheceu outras 65 como idênticas. O manifest passou de 6.048 para
6.075 partições. O commit local foi criado, mas o rebase recusou o
`state/pending.json` modificado pelo download do artefato.

O checkout do job seguinte apagou o build e o commit local. Os DBCs
continuam no cache. Uma cópia independente por reflink foi salva em
`~/precisa-recovery/datasus-parquet/45231634914/raw-cache` no desktop,
junto ao pending original.

## Critérios de aceitação

- [x] O trecho real do workflow consegue rebasing e push com pending
      modificado e arquivo não rastreado, preservando ambos. Prova: teste
      `refresh-state-commit.test.ts` com repositórios Git locais e avanço remoto.
- [x] O commit publicado contém apenas `state/sia-pa.json`.
      Prova: inspeção do diff no mesmo teste.
- [x] Em caso de falha após a atualização do state, o workflow guarda
      state, pending e relatórios de verificação como artefato de recuperação.
      Prova: teste de configuração e revisão do YAML.
- [x] O state recuperado altera somente as 325 entradas do pending deste
      run, com tamanho e mtime originais. Prova: comparação com o artefato
      baixado do GitHub e com a cópia preservada no desktop.
- [x] Lint, typecheck e testes passam.

## Fora de escopo

Não executar archive, republicar Parquet, emitir DOI ou disparar refresh
do viz nesta correção. A recuperação do state passa por PR. Não adicionar
dependências nem alterar o cache do SDK.

## Correção e recuperação

Cache e pending preservados fora do checkout. A PR #69 reúne a correção do
refresh (`577c701`), a recuperação do state (`b103223`) e o isolamento da
configuração Git das fixtures (`5b29d21`).

O primeiro pre-commit revelou que as fixtures herdavam `GIT_DIR` e
`GIT_INDEX_FILE` do hook. Cinco commits de fixture foram enviados
indevidamente à main, terminando em `a340df0`. O PR corretivo restaura
README e pending da base `3a73a38`, além de recuperar o state completo.
Não há reescrita do histórico remoto. Os subprocessos de teste agora
removem as variáveis Git herdadas e permitem somente transporte local
(`file`), com checagem do gitdir e do origin antes de qualquer commit.

### Evidências

- O teste novo falhou antes da correção com o mesmo erro de alterações
  não preparadas do runner. Depois da correção, passaram os cenários com
  main avançando e sem avanço, além da checagem do artefato de recuperação.
- `pnpm lint` e `pnpm typecheck`: sucesso.
- `pnpm test:coverage`: 245 testes em 18 arquivos, 100% linhas e 98,78%
  branches. As fixtures Git usam chaves SSH temporárias para assinar os
  commits sem depender da identidade configurada na máquina.
- O SHA-256 do pending do GitHub coincide com a cópia do desktop:
  `3dbf404d490976d43a777886cbbe8ebd7a13193ba81b68c73f315cd74a22ba6e`.
- Comparação estrutural com a base `3a73a38`: exatamente 325 entradas de
  `processed` alteradas, todas com tamanho e mtime do pending. As demais
  entradas ficaram intactas. O `lastRun` foi atualizado para o horário
  desta recuperação, `2026-11-24T10:26:39.781Z`.
- Listagem atual do S3 confirma os 325 pares de Parquet/provenance e
  todos os 260 uploads de Parquet identificados no log.

## Revisão

Na revisão, o README foi confirmado idêntico à base `3a73a38`. A
contradição de versões já existia e a restauração foi preservada.

O isolamento adicional desativa configuração global e de sistema nas
fixtures e usa template vazio. O teste com configuração global contaminada
falhou antes da correção e passou depois. A verificação de configuração de
sistema usa um arquivo temporário com uma chave sentinela: a leitura
explícita com `--system` confirma sua existência, enquanto a configuração
efetiva do repositório não pode conter essa chave. A checagem não depende
da representação relativa ou absoluta dos caminhos em `--show-origin`.
Os hooks reais do projeto permanecem ativos.

## Encerramento

A PR #69 foi mesclada em `af5610f`. A árvore da `main` ficou idêntica ao
último commit da PR, e README e pending ficaram idênticos à base `3a73a38`.

- Release [`dataset-2026-09`](https://github.com/Precisa-Saude/datasus-parquet/releases/tag/dataset-2026-09)
  criada à mão a partir de `af5610f`, com o corpo do workflow e o
  `manifest.json` publicado pelo run 45231634914 (`generatedAt`
  `2026-11-24T00:27:24.609Z`, 6.075 partições). O run tinha calculado
  `releaseCompetencia` 2026-09, com o state indo até 2026-08.
- O webhook do Zenodo emitiu o DOI
  [10.5281/zenodo.24507473](https://doi.org/10.5281/zenodo.24507473).
- `refresh.yml` do datasus-viz disparado à mão:
  [run 45439370228](https://github.com/Precisa-Saude/datasus-viz/actions/runs/45439370228).
- `refresh.yml` deste repositório disparado depois do merge
  ([run 45439376998](https://github.com/Precisa-Saude/datasus-parquet/actions/runs/45439376998)):
  o `detect` encontrou 0 pendentes, com o state indo até 2026-09, e o
  `archive` foi pulado. O passo de commit corrigido só será exercido na
  próxima publicação do DATASUS.

Pendente: apagar o snapshot do desktop depois que um refresh com
publicação nova commitar o state sem falha.
