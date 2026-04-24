# Setup Zenodo — DOI automático por release

Cada tag de release em `datasus-parquet` deve receber um DOI Zenodo
pra ser citável academicamente. O setup é feito uma vez na UI do
Zenodo; depois funciona automaticamente pra cada nova release.

## Pré-requisito

Repo deve ser **público**. Já é o caso.

## Passos (uma vez, manual)

### 1. Acessar a página de integração GitHub do Zenodo

https://zenodo.org/account/settings/github/

Logar com conta que tenha acesso de admin ao `Precisa-Saude/datasus-parquet`. Se ainda não tem conta Zenodo, criar via "Sign up" (aceita login via GitHub ou ORCID).

### 2. Localizar o repositório na lista

Na página de configurações, procurar `Precisa-Saude/datasus-parquet` na lista de repos disponíveis. Se não aparecer, clicar em "Sync now" no topo.

### 3. Ativar o toggle

Flipar o switch `OFF → ON` ao lado de `Precisa-Saude/datasus-parquet`. A partir desse momento, cada release criada no GitHub dispara o webhook e Zenodo faz:

1. Baixa o tarball do release
2. Preserva no Zenodo storage
3. Emite um **Version DOI** (ex.: `10.5281/zenodo.1234567`)
4. Emite/atualiza o **Concept DOI** (aponta sempre pro último release; formato similar `10.5281/zenodo.1234566`)

### 4. Criar release de teste (primeiro DOI)

```bash
gh release create v0.1.0-test \
  --repo Precisa-Saude/datasus-parquet \
  --title "v0.1.0-test" \
  --notes "Release de teste pra validar integração Zenodo."
```

Aguardar ~2min. Em https://zenodo.org/me/uploads deve aparecer a versão. Copiar o Concept DOI (o que NÃO muda entre versões).

### 5. Atualizar CITATION.cff com o Concept DOI

```diff
 identifiers:
   - type: doi
-    value: 10.5281/zenodo.PENDING
+    value: 10.5281/zenodo.XXXXXXX
     description: Concept DOI (Zenodo) — aponta sempre pro último release.
```

Commitar em `main` como `docs(citation): preencher Concept DOI Zenodo`.

### 6. (Opcional) Deletar o release de teste

Se quiser começar limpo, deletar o release no GitHub. O DOI Zenodo
continua válido (preservado), mas a aba "releases" do repo fica vazia.

## Como funciona dia-a-dia

- Cada release nova no GitHub → novo Version DOI automaticamente
- Concept DOI continua apontando pro release mais recente
- Ambos aparecem na página Zenodo do repo
- Quem cita pode usar:
  - **Concept DOI** — pra referenciar o dataset em geral (atualiza com novas versões)
  - **Version DOI** — pra reproduzir um trabalho com a versão exata usada

## Referências

- Zenodo GitHub guide: https://docs.github.com/en/repositories/archiving-a-github-repository/referencing-and-citing-content
- Zenodo DOI versioning: https://help.zenodo.org/docs/deposit/describe-records/versioning/
