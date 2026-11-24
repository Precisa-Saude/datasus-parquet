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

## Status atual

Cache e pending preservados fora do checkout. State recuperado localmente.
Mensagens dos dois commits aprovadas; publicação do PR em andamento.

### Evidências

- O teste novo falhou antes da correção com o mesmo erro de alterações
  não preparadas do runner. Depois da correção, passaram os cenários com
  main avançando e sem avanço, além da checagem do artefato de recuperação.
- `pnpm lint` e `pnpm typecheck`: sucesso.
- `pnpm test:coverage`: 244 testes em 18 arquivos, 100% linhas e 98,78%
  branches. As fixtures Git usam chaves SSH temporárias para assinar os
  commits sem depender da identidade configurada na máquina.
- O SHA-256 do pending do GitHub coincide com a cópia do desktop:
  `3dbf404d490976d43a777886cbbe8ebd7a13193ba81b68c73f315cd74a22ba6e`.
- Comparação estrutural com `origin/main`: exatamente 325 entradas de
  `processed` alteradas, todas com tamanho e mtime do pending. As demais
  entradas ficaram intactas. O `lastRun` foi atualizado para o horário
  desta recuperação, `2026-11-24T10:26:39.781Z`.
- Listagem atual do S3 confirma os 325 pares de Parquet/provenance e
  todos os 260 uploads de Parquet identificados no log.

## Próximos passos

Após aprovação, commitar a correção e a recuperação em commits separados,
abrir PR com estes critérios e evidências. Não iniciar outro refresh.
