<!--
Copyright 2026 Volt Data Lab
SPDX-License-Identifier: AGPL-3.0-only
-->

# Pacotes candidatos de fontes (não executáveis)

Receita local para revisão. Não é instalação, distribuição aprovada, teste de runtime,
scanner de segredos ou autorização para executar os candidatos.

## Pré-requisitos e comandos

- Linux, Node **22.23.2**, GNU tar **1.34** (versões exercitadas).
- `TMPDIR` explicitamente apontando para scratch privado do perfil, já existente.
- Corpus plano com os bytes aprovados de `candidate-files.json`; o snapshot de teste
  `spikes/infra-mcp-source-snapshot/` é fornecido separadamente, não regenerado pela receita.
- `candidate-files.json` e `check.mts` adjacentes à receita, inalterados e confiáveis.
- Diretório pai da saída existente e privado; a saída solicitada **não pode existir**.
  Não há defesa contra alterações concorrentes de diretórios ancestrais por terceiros.

A partir da raiz do checkout isolado:

```sh
node spikes/infra-mcp-packaging/pack.mts <flat-source-corpus> <NEW-output-dir>
node --test spikes/infra-mcp-packaging/pack.test.mts
```

Não usar package manager. A receita não instala dependências, importa candidatos,
executa scripts de `package.json`, inicia serviços nem abre sockets.

## Saída e verificações

Uma execução bem-sucedida imprime `PACKAGES_MATCH` e retorna zero. A saída contém somente:

- `candidate-backend.tar`
- `candidate-observer.tar`
- `candidate-operator.tar`
- `SHA256SUMS` (hash SHA-256, dois espaços, nome relativo do arquivo).

Cada perfil contém exatamente os nomes e hashes literais do manifesto aprovado,
incluindo as três licenças originais (`LICENSE-AGPL-3.0`, `LICENSE-COMMERCIAL`,
`LICENSE-GPL-3.0`), `package.json` e `pnpm-lock.yaml` como **dados inertes**.
Não interpretar a presença dessas licenças como concessão de direitos adicionais.
Nenhum hash de fonte é atualizado ou regenerado para aceitar diferenças.

Os arquivos são copiados por nome explícito para stages privados. A receita chama o
checker aprovado via CLI em cada stage antes de gerar seu tar. Não varre o corpus:
extras, diretórios adicionais, testes, contexto e bancos não listados são ignorados,
não lidos nem incluídos. Um nome estranho em um extra não o torna entrada do pacote.
A seleção confiável é o manifesto, não uma descoberta automática de arquivos.

GNU tar recebe uma lista plana explícita e ordenada, `--no-recursion`, formato
`ustar`, mtime zero, uid/gid zero e modo 0644. O ambiente dos subprocessos fixa
`LC_ALL=C` e `TZ=UTC`, sem herdar `TAR_OPTIONS` ou `NODE_OPTIONS`.
Não há prefixo de caminho do checkout, timestamps de execução, atime ou recibo variável
nos artefatos. Stages separados evitam transformar arquivos repetidos em hard links.

Depois da criação, a receita verifica a listagem real, tipos regulares/metadados e
SHA-256 de **cada membro real** usando `tar -xOf`. Não usa extração de caminhos de um
tar. Os testes reconstituem membros previamente validados como arquivos próprios e
invocam o checker sobre esses bytes, além de comparar duas execuções byte a byte
após variar modos e datas das entradas.

## Rejeições e limites

Falhas imprimem `PACKAGES_REJECTED` e retornam 1. Fonte obrigatória ausente,
alterada, symlink, diretório ou arquivo maior que 16 MiB não é aceita. A abertura
usa `O_NOFOLLOW | O_NONBLOCK`, e `fstat` exige arquivo regular; assim FIFO não é lida
nem aguardada. Nenhum teste cria ou comunica por FIFO. O checker aprovado mantém
suas regras fechadas de nomes e hashes; sua suíte e seu schema não são reabertos aqui.
O corpus raiz não pode ser symlink, inclusive com barra final.

A saída só é criada após verificar todos os pacotes. Diretório, arquivo ou symlink
preexistente não é sobrescrito. Gravações usam `wx`. Falha de I/O durante a cópia
final pode deixar saída parcial: trate qualquer retorno não zero como rejeição,
não reutilize essa saída. A receita não remove saídas solicitadas pelo usuário.
Só a árvore temporária criada pela própria execução em `TMPDIR` é removida no
`finally`; testes removem somente suas fixtures próprias.

Os testes novos cobrem determinismo, membros/metadados/hashes/licenças, checker dos
bytes arquivados, entradas ausentes/corrompidas/symlinks/diretórios/sobredimensionadas,
saídas preexistentes e exclusão de extras sintéticos (incluindo sentinelas `throw`).
Eles não importam nem executam os TS do snapshot e não acessam secret stores.
Isso verifica empacotamento estático, não comportamento do código transportado.

## Gate TypeScript separado

Somente os dois novos MTS entram no gate; os candidatos continuam inertes.
No ambiente de revisão, usar o compilador **7.0.2** existente no checkout original
por caminho absoluto, sem instalação:

```sh
TOOLCHAIN=/path/to/preexisting-reviewed-toolchain
node "$TOOLCHAIN/node_modules/.pnpm/typescript@7.0.2/node_modules/typescript/bin/tsc" \
  --ignoreConfig --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext \
  --allowImportingTsExtensions --strict --skipLibCheck \
  --typeRoots "$TOOLCHAIN/spikes/infra-mcp/node_modules/@types" --types node \
  spikes/infra-mcp-packaging/pack.mts spikes/infra-mcp-packaging/pack.test.mts
```

Evidências de RED/GREEN, comandos, saídas, versões e hashes ficam fora do repositório
em `context/evidence/piloto-mcp-source-packages/implementation.json` no workspace do
perfil. Nenhuma publicação, commit, push, PR, execução de runtime ou aprovação final
é feita por esta receita.
