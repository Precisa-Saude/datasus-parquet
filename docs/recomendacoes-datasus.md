# Recomendações ao DATASUS sobre a publicação de microdados no FTP

> Documento de trabalho escrito pela perspectiva de quem consome os
> microdados de forma programática. Todas as observações abaixo foram
> verificadas contra `ftp.datasus.gov.br` em novembro de 2026, no diretório
> `/dissemin/publicos/SIASUS/200801_/Dados` (SIA-PA).

## Quem somos e o que fazemos com os dados

A Precisa Saúde mantém um conjunto de ferramentas de código aberto para
consumir os microdados do DATASUS: `datasus-dbc` (decodificador do formato
DBC), `datasus-sdk` (download e leitura tipada), `datasus-parquet`
(conversão para Parquet com proveniência e DOI) e `datasus-viz`
(geovisualização). Toda semana sondamos o FTP, detectamos o que mudou,
reprocessamos e republicamos. As recomendações a seguir vêm desse ciclo e
visam reduzir o custo de manter uma cópia fiel e atualizada dos dados —
para nós e para qualquer pesquisador que faça o mesmo.

## 1. Data de modificação legível por máquina

**Observação.** O servidor responde à listagem no formato DOS
(`MM-DD-YY hh:mmAM`), com resolução de minuto e fuso horário não
informado, e não anuncia suporte a `MLSD`. Em clientes FTP padrão (por
exemplo `basic-ftp`), o campo `modifiedAt` fica vazio; só resta a string
bruta da listagem.

**Impacto.** Cada consumidor precisa escrever o próprio parser da data e
assumir um fuso. Até corrigirmos isso do nosso lado, nosso detector
gravava 1970 em todas as entradas e comparava arquivos só por tamanho.

**Recomendação.** Opção mais barata: habilitar `MDTM` e `MLSD` no servidor
(ambos padrão em servidores FTP atuais). Alternativa: publicar um
timestamp ISO-8601 com fuso num índice legível por máquina (ver item 5).

## 2. Registro do que mudou em cada publicação

**Observação.** Cada publicação mensal reescreve a competência nova e as
11 anteriores. Em 2026-10-30, os arquivos de 2025-09 a 2026-08 receberam
o mesmo mtime novo; 2025-08 ficou como estava. Nada indica quais dos 12
meses reescritos tiveram conteúdo alterado.

**Impacto.** Quem precisa de uma cópia fiel tem de tratar os 12 meses
como alterados a cada publicação.

**Recomendação.** Um changelog por publicação (texto simples já resolve)
listando os arquivos cujo conteúdo mudou, ou um marcador "inalterado"
por arquivo no índice do item 5.

## 3. Tamanho e mtime não indicam mudança de conteúdo

**Observação.** `PAAC2509.dbc` passou de 4.932.873 para 4.472.719 bytes
entre duas publicações. Decodificados, os dois arquivos são idênticos:
173.845 registros, mesmos totais, nenhuma linha adicionada ou removida.

**Impacto.** Os dois sinais disponíveis no FTP (tamanho e data) geram
falsos positivos. A única forma de saber se um arquivo mudou é baixar e
decodificar. Para uma publicação inteira isso significa cerca de 324
arquivos (12 meses × 27 UFs) e 8 a 10 horas de processamento, mesmo
quando a maioria não mudou.

**Recomendação.** Publicar um checksum (SHA-256) por arquivo, idealmente
do conteúdo decodificado (DBF), já que a recompressão altera o DBC sem
alterar os dados. Com isso, um consumidor compara um hash em vez de
baixar e decodificar.

## 4. Política de revisão documentada e, se possível, deltas

**Observação.** Em `PAAC2607.dbc`, a revisão foi um acréscimo puro:
39.313 registros adicionados, nenhum removido ou alterado, todos com
`PA_MVM = 202607`, vindos de 83 estabelecimentos ausentes na primeira
versão.

**Impacto.** Sem a política escrita, não há como saber quantos meses
ficam abertos a revisão, quando uma competência passa a ser definitiva,
nem se revisões podem remover ou alterar registros já publicados.

**Recomendação.** Opção mais barata: documentar a política de revisão
(janela aberta, critério de fechamento, tipos de alteração possíveis).
Alternativa: publicar, além do arquivo completo, um arquivo de delta por
publicação (registros adicionados e removidos), o que reduziria o
reprocessamento a uma fração do volume.

## 5. Índice por diretório e formatos abertos

**Observação.** Os arquivos estão em DBC (DBF comprimido em formato
próprio, que exige decodificador dedicado); UFs grandes são divididas em
partes com sufixo de letra no nome do arquivo; não há manifesto de
checksums nem índice legível por máquina do que existe ou do que mudou.

**Impacto.** Cada consumidor reimplementa a descoberta de arquivos, a
junção das partes e a verificação de integridade, sem referência oficial
para conferir.

**Recomendação.** Um manifesto por diretório (JSON ou CSV) com, por
arquivo: nome, tamanho, SHA-256, data de modificação em ISO-8601,
competência, UF e número de registros. Esse arquivo resolve também os
itens 1, 2 e 3. Num segundo momento, oferecer um formato aberto
(Parquet, ou CSV com gzip) ao lado do DBC.

## 6. Calendário de publicação

**Observação.** A defasagem entre competência e publicação é de cerca de
dois meses, e o dia varia: em 2026, junho saiu em 12 de agosto, julho em
17 de setembro e agosto em 30 de outubro.

**Impacto.** Sondagens automáticas rodam no vazio na maior parte das
semanas e, quando a publicação atrasa, não há como distinguir atraso de
problema.

**Recomendação.** Um calendário público de publicação (mesmo que
aproximado), ou uma data prevista no índice do item 5.

## O que já fazemos do nosso lado

Publicamos os microdados do SIA-PA convertidos para Parquet, com
proveniência por partição (nome, tamanho e SHA-256 do DBC de origem,
contagem de registros, versão do código) e DOI por publicação via
Zenodo. O decodificador DBC e todo o pipeline são de código aberto.
Teremos prazer em compartilhar o que aprendemos, testar qualquer
formato ou índice que a equipe considere adotar e contribuir com
ferramentas.
