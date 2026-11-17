<!--
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
-->

# Receita: dependências somente de produção

Valida **dados de duas instalações novas**, não o funcionamento do MCP. Não importa módulos
instalados, não executa entrypoints, scripts de pacotes, hooks, compiladores ou suítes anteriores.
Não inicia piloto, serviços, listeners, IPC, systemd ou deploy. O pnpm é a ferramenta de instalação
explicitamente fornecida, não uma dependência importada pelo validador.

## Pré-requisitos e execução

- Node **22.23.2**, executando diretamente o `.mts` com suporte nativo a TypeScript apagável.
- pnpm **12.11.2** já disponível em um caminho absoluto. Não há bootstrap, descoberta no PATH,
  download de outra CLI ou fallback. `.mjs`/`.cjs` são executados por `process.execPath`;
  outro caminho é executado diretamente, sem shell (inclui o binário nativo utilizado em CI).
- Acesso ao registry público npm para baixar as dependências. O script não instala ferramentas dev.
- `TMPDIR` existente, gravável e **fora do monorepo**, inclusive fora do checkout da receita.
- Diretório de saída **inexistente**, com pai existente. Nunca reutilize uma saída anterior.

A partir da raiz do checkout, substitua os caminhos absolutos abaixo:

```sh
node --test spikes/infra-mcp-production/validate.test.mts

node spikes/infra-mcp-production/validate.mts \
    "$PWD/spikes/infra-mcp-source-snapshot" \
    /caminho/absoluto/pnpm.mjs \
    /caminho/absoluto/nova-evidencia
```

Para o executável nativo, o segundo argumento é simplesmente `/caminho/absoluto/bin/pnpm`,
sem prefixo especial. Ambos os caminhos precisam retornar `12.11.2` no probe `--version`.
A validação local exercitou a CLI `.mjs` em cache, não o executável nativo de CI.
Nenhum comando desta receita requer `pnpm install` na raiz ou instalação de devDependencies.

## Isolamento por construção

Cada instalação utiliza um `mkdtemp` próprio em `TMPDIR`, com `project`, `home`, `config`, `cache`,
`data`, `state`, `tmp`, `pnpm-home` e **store separado inicialmente vazio**. O projeto começa apenas
com cópias byte a byte de `package.json` e `pnpm-lock.yaml`; não recebe `.npmrc`, pnpmfile,
workspace, fontes, entrypoints ou configuração do monorepo.

O ambiente do subprocesso é construído do zero: PATH contém somente o diretório de
`process.execPath`, `/usr/bin` e `/bin`; HOME, XDG_CONFIG_HOME, XDG_CACHE_HOME, XDG_DATA_HOME,
XDG_STATE_HOME, TMPDIR e PNPM_HOME apontam para a instalação descartável. CI=true, LC_ALL=C e
TZ=UTC são explícitos. `npm_config_userconfig` e `npm_config_globalconfig` apontam para arquivos
vazios próprios; `npm_config_ignore_scripts=true` complementa, mas **não substitui**, o flag CLI.
Nenhuma variável de credenciais, proxy, NODE_OPTIONS ou configuração do caller é copiada.

Instalação efetiva:

```text
install --prod --frozen-lockfile --ignore-scripts
  --ignore-pnpmfile --ignore-workspace
  --config.manage-package-manager-versions=false
  --registry=https://registry.npmjs.org/
  --config.verify-store-integrity=true
  --config.side-effects-cache=false
  --config.update-notifier=false --config.fetch-retries=0
  --reporter=ndjson --store-dir=<STORE-PRÓPRIO>
```

Os dois streams são auditados como NDJSON (nesta versão, os eventos chegam em stderr).
Qualquer `pnpm:lifecycle`, ausência de `pnpm:ignored-scripts` ou `packageNames` não vazio nesse
último evento bloqueia a receita. **Não habilite scripts para corrigir uma falha.**
Se lockfile, permissões, versão, scripts ou hooks impedirem a execução, pare e registre o bloqueio.

O registry é um controle **declarativo** por URL CLI e pelas entradas auditadas imutáveis;
não é firewall, sandbox de SO ou prova de confinamento da rede. Não se infere configuração
efetiva completa de `pnpm config list`, nem se publica esse conteúdo.

## Referência de integridade e verificações

`expected-inventory.json` é uma referência criada uma vez, em auditoria independente:
os 92 tarballs públicos foram baixados e tiveram SHA-512 SRI comparado ao lockfile original
(que contém dois documentos) e ao índice do store próprio. Os membros regulares publicados
foram comparados byte a byte aos arquivos instalados. Esta receita **reutiliza** essa auditoria;
não baixa novamente tarballs para reconstruir metadados e não interpreta YAML por aproximação.

O SHA-256 da referência é fixado no código:
`81807cd18a673e4829cc5a23f9a8cdf000aa112a1140d671f10008ff8cc7c757`.
A referência fixa também os SHA-256 do par exato de inputs. Não regenere referência, inventário
esperado ou hashes para aceitar divergências. Alterar dependências exige outra auditoria revisada.

Em cada instalação, a receita verifica:

1. Inputs originais e copiados preservados, por SHA-256; Node e pnpm nas versões exatas.
2. Exatamente 92 identidades físicas, localizadas nos slots reais de
   `node_modules/.pnpm/<slot>/node_modules`, inclusive namespaces scoped. Symlinks de dependências
   não são confundidos com primários. `package.json` é lido como JSON, nunca importado.
3. Cada nome de arquivo publicado e cada SHA-512 contra a referência: 3.638 arquivos por instalação.
   Arquivos extras, ausentes, especiais ou symlinks dentro do pacote são recusados, salvo os dois
   arquivos regulares gerados pelo instalador explicitamente listados na referência.
4. Os dois shims `node_modules/.bin/node-which`, sob `cross-spawn` e `which`, **não** são membros
   dos tarballs auditados por SRI. Apenas nesses arquivos substitui-se o root da instalação por
   `<INSTALL>` antes do SHA-512. Não se aplica outra normalização e não se impõe o digest de shim
   de outro host. Seus nomes são fixos e seus digests normalizados precisam coincidir entre A/B.
5. Nenhuma devDependency direta, vitest, oxfmt, typescript, `@typescript/native`, `@vitest/*` ou
   `@typescript/typescript-*` instalada. Os nomes dos binários dev também são recusados nas
   pastas `.bin` raiz e do virtual store; nenhum binário de dependência é executado.
6. Links diretos apontam para os primários esperados: SDK 1.32.2, express 5.3.0 e zod 4.6.7.
7. Exatamente as 92 chaves `<tarball SRI>\t<nome>@<versão>` no `store/v11/index.db` próprio.
   `node:sqlite` abre esse índice **readonly**, consultando apenas `key`, nunca BLOB/msgpack.
   Não há acesso a SQLite da aplicação; o aviso experimental do Node refere-se a essa API de metadata.
8. Cada arquivo CAS em `store/v11/files/<2hex>/<126hex>[-exec]` tem SHA-512 igual ao seu endereço.
   Depois, `pnpm store status --ignore-pnpmfile --ignore-workspace --store-dir=<STORE-PRÓPRIO>
   --config.manage-package-manager-versions=false` precisa retornar zero.
9. Inventários ordenados A/B iguais, incluindo SRI, todos os digests e os shims normalizados.

## Evidências, falhas e limites

A saída contém `inventory-a.json`, `inventory-b.json` e `receipt.json`: dados relativos, sem
HOME, caminhos absolutos de execução, tokens, hostname, PID ou logs brutos do pnpm. O recibo
registra status, fase, contagens, controles aplicados e resumo da auditoria de scripts.
Falha retorna exit 1, com `status: fail` quando foi possível criar a saída. Falha antes de criar
uma saída exclusiva (argumentos, saída existente ou permissões) não sobrescreve nem cria recibo
em um diretório alheio. Inventário parcial nunca equivale a sucesso.

O cleanup remove somente os roots retornados pelos `mkdtemp` desta invocação, inclusive em falhas
normais. Não remove fonte, checkout ou saída. Interrupção abrupta do processo/SO pode deixar
roots temporários; não há claim de limpeza sob SIGKILL. Nunca apague caminhos por glob para compensar.

Os testes novos usam `node:test`, fixtures sintéticas e a CLI em cenários de recusa **sem rede**.
Não simulam instalações bem-sucedidas. A prova positiva é a execução real separada da CLI,
com dois stores novos. O resultado observado localmente foi 92 pacotes, 3.638 arquivos publicados,
dois shims e 3.157 arquivos CAS verificados por instalação; `store status` zero em ambas,
nenhum lifecycle e inventários normalizados idênticos.

Isto **não** comprova compatibilidade de import, tipos ou runtime, nem autoriza piloto ou deploy.
Compiladores (inclusive o gate TS7), entrypoints e suítes anteriores permanecem fora do escopo.
