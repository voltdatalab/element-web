# Criação de agentes Pi no Element

Primeira fatia da [direção do Element Agents](https://github.com/fmercurio/claw-tenant/issues/167), acompanhada na [issue 1 deste fork](https://github.com/voltdatalab/element-web/issues/1).

O menu **Criar agente** abre um formulário de nome e descrição. O serviço autentica o dono pela sessão Matrix, provisiona um usuário de bot e uma DM privada criptografada, abre uma conversa Pi Durable e devolve a sala. O Element entra na sala e registra a DM. Novas mensagens do dono são admitidas em uma fila persistente, processadas pelo Pi e respondidas com transação Matrix estável.

A revisão inicial usa Pi Durable 1.5.2, os providers `openai` (API key) e `openai-codex` (token de acesso), com o modelo da variável `PI_MODEL`. As ferramentas de shell e arquivos pertencem à fatia Firecracker posterior. O estado Pi, a identidade Matrix e as credenciais ficam no serviço.

## Executar o serviço

Usar Node 22.19 ou superior e as dependências do workspace instaladas. Configurar no ambiente do serviço as seguintes variáveis.

| Variável                       | Uso                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------ |
| `MATRIX_HOMESERVER`            | URL fixa do Synapse da instalação.                                                         |
| `MATRIX_SERVER_NAME`           | Domínio dos IDs Matrix desse servidor.                                                     |
| `MATRIX_ADMIN_TOKEN`           | Credencial de provisionamento de usuários do Synapse, restrita ao backend.                 |
| `ELEMENT_AGENTS_ALLOWED_USERS` | MXIDs autorizados a criar agentes, separados por vírgula.                                  |
| `PI_PROVIDER`                  | `openai` (padrão) ou `openai-codex`.                                                       |
| `OPENAI_API_KEY`               | Credencial para o provider `openai`.                                                       |
| `PI_CODEX_ACCESS_FILE`         | Caminho de arquivo privado com `access` e `expires` em milissegundos, para `openai-codex`. |
| `PI_MODEL`                     | ID do modelo no catálogo Pi fixado.                                                        |
| `ELEMENT_AGENTS_STATE_DIR`     | Diretório privado persistente, padrão `./state`.                                           |
| `HOST` / `PORT`                | Bind do serviço, padrão `127.0.0.1:8787`.                                                  |

```sh
pnpm --filter @voltdatalab/element-agents start
```

O diretório de estado usa permissões privadas e lock com heartbeat para um único processo escritor. Ao reiniciar, o serviço recupera cadastros, credenciais dos dispositivos, salas, conversas Pi e mensagens pendentes. Uma requisição de criação repetida conserva sua chave e seu corpo. O navegador guarda esse rascunho por usuário na sessão da aba até conseguir abrir a DM.

Ativar `clawdia_agents` no `config.json` do Element e rotear `/clawdia/` na mesma origem para o serviço. Em desenvolvimento, `ELEMENT_AGENTS_URL` configura o proxy do servidor web. A API recebe o access token Matrix da sessão pelo cabeçalho Authorization e consulta `whoami` no homeserver configurado. O corpo do formulário fornece nome e descrição.

## Laboratório no nucleotech-02

O compose tem nome, rede, volumes e portas próprios. Publica Synapse em `127.0.0.1:18008` e a API em `127.0.0.1:18787`. Preparar a configuração do Synapse uma vez, a partir de `apps/agents`.

```sh
docker compose run --rm -e SYNAPSE_SERVER_NAME=clawdia-lab.local -e SYNAPSE_REPORT_STATS=no synapse generate
docker compose up -d synapse
```

Criar o usuário de laboratório pelo `register_new_matrix_user` do Synapse e obter sua credencial administrativa para `MATRIX_ADMIN_TOKEN`. Guardar as variáveis acima em `.env` local, protegido, e então executar `docker compose up -d --build agents`. O admin token pertence somente a este homeserver de laboratório. As portas de loopback podem ser acessadas por túnel SSH.

Para o provider Codex no laboratório, colocar uma cópia autorizada apenas do token de acesso em `/data/codex-access.json`, no volume privado do serviço, com modo `0600` e dono do processo. Definir `PI_PROVIDER=openai-codex`, `PI_CODEX_ACCESS_FILE=/data/codex-access.json` e o `PI_MODEL` existente na instalação. O arquivo tem formato `{"access":"<token>","expires":<epoch em milissegundos>}`. O serviço relê o arquivo a cada resolução de autenticação e recusa tokens a menos de cinco minutos da expiração. A renovação fica com o dono da credencial. O laboratório não recebe refresh token e não altera o perfil Hermes. Uma nova cópia de acesso deve ser provisionada após a renovação da origem.

O arquivo `element.config.example.json` configura o cliente para esse laboratório. O serviço web em desenvolvimento pode usar `ELEMENT_AGENTS_URL=http://127.0.0.1:18787`. Para validar o produto, criar o agente pela interface, enviar uma mensagem na DM e reiniciar o serviço, verificando a continuidade da conversa e da mesma sala.

## Verificação

Os testes do store cobrem repetição, conflito e recuperação de provisionamento/fila. O teste Pi usa harness e SQLite reais com provider determinístico. Os testes HTTP verificam identidade, acesso, tamanho de entrada e ausência de segredos na resposta. Os testes do view model e do formulário cobrem abertura, erro, recarga e submissão repetida. O Playwright cobre o fluxo de interface com resposta de provisionamento controlada.

Uma resposta de LLM e uma DM real no laboratório constituem verificações adicionais, registradas na issue com ambiente e versão. O provider determinístico comprova a integração persistente do harness.

Para repetir os testes integrados, usar um arquivo privado do usuário de laboratório com `user_id`, `password` e `access_token`, e definir `CLAWDIA_MATRIX_TEST_CREDENTIALS` com seu caminho. `CLAWDIA_MATRIX_TEST_URL` seleciona o Synapse, com padrão de loopback na porta 18008.

```sh
CLAWDIA_MATRIX_TEST_CREDENTIALS=/caminho/privado/usuario-lab.json node --test --test-force-exit apps/agents/src/matrix.integration.test.ts
BASE_URL=http://127.0.0.1:8088 CLAWDIA_MATRIX_TEST_CREDENTIALS=/caminho/privado/usuario-lab.json pnpm --filter element-web exec playwright test playwright/e2e/agents/live-onboarding.spec.ts --project=Chrome --ignore-snapshots
```

Para validar uma resposta real pela interface, iniciar o serviço normal com o provider e o modelo configurados e acrescentar `CLAWDIA_REAL_MODEL_TEST=1` ao comando Playwright acima. Esse modo verifica uma soma com valores e marcador aleatórios e uma segunda resposta que depende do histórico. O relatório anexa o diálogo de teste e a captura da DM.

O teste de processo também aceita `CLAWDIA_REAL_MODEL_TEST=1` com as variáveis do provider para validar a mesma DM e o histórico Pi após reiniciar o processo com LLM real. Sem essa opção, usa o provider determinístico por importação explícita da fixture. O teste de navegador requer uma API de laboratório iniciada com a mesma fixture, em estado separado. De `apps/agents`, com as demais variáveis Matrix configuradas, esse processo pode ser iniciado assim.

```sh
NODE_ENV=test PI_MODEL=faux-1 OPENAI_API_KEY=integration-fixture-unused node --import ./src/fixtures/faux-model.ts src/server.ts
```

A fixture exige `NODE_ENV=test`. O comando normal do serviço usa o provider configurado no código, e a prova com modelo real precisa ser registrada separadamente.

## Workspace Firecracker por agente

A fatia seguinte está em `firecracker/`, vinculada às issues [#167](https://github.com/fmercurio/claw-tenant/issues/167) e [#145](https://github.com/fmercurio/claw-tenant/issues/145). O [README do worker](./firecracker/README.md) descreve instalação, recursos, isolamento, persistência e aceite pelo navegador.

O override `compose.firecracker.yaml` conecta o container sem privilégios ao socket do worker host. A variável `FIRECRACKER_LAB_SOCKET` ativa o provisionamento de uma máquina por cadastro e as ferramentas Pi de arquivo e reinício. A configuração base preserva a execução da primeira fatia. O worker deve ser instalado e validado antes de ativar esse override.

## Compartilhar uma sala somente com texto

O dono pode convidar o bot usando o Element e autorizar uma sala privada criptografada pela DM original:

```text
!clawdia compartilhar https://matrix.to/#/!id-da-sala
!clawdia revogar https://matrix.to/#/!id-da-sala
```

O comando de compartilhamento registra a audiência atual após conferir os membros locais, a criptografia e a permissão do dono para convidar. A entrada do bot só acontece para o convite indicado pelo dono. Aguarde a confirmação na DM antes de mencionar o agente na sala. O gateway aceita somente eventos descriptografados com menção explícita em `m.mentions.user_ids`; convites e mensagens em outras salas não concedem acesso.

Cada sala e revisão de acesso têm um SQLite Pi próprio em `rooms/<hash-da-sala>/<revisão>/pi.sqlite`. O transcript e as ferramentas de arquivo da DM continuam privados. A sala não instala ferramentas de máquina, não consulta a fila de artefatos e não importa histórico anterior ao vínculo. Os IDs do lote inicial descartado são retidos para impedir sua admissão após uma repetição de sync. O cursor Matrix é persistido depois da admissão local.

Mudanças na audiência ou nos estados de acesso suspendem o vínculo e bloqueiam os turnos antigos. Uma nova autorização cria outra revisão e contexto vazio. Revogar pela DM grava o bloqueio antes de esperar pelo modelo e aborta a conversa compartilhada. A autorização é conferida antes de executar e de entregar, também no despacho ao provider e nos retries. Erros de consulta de permissões suspendem o acesso.

O outbox da sala persiste resposta, destino, revisão e payload cifrado. Uma retomada autorizada usa a mesma transação Matrix. Envios já iniciados quando ocorre revogação ficam identificados como incertos e não são reenviados depois dela. Mensagens já enviadas seguem o histórico Matrix.

Os testes `RoomSharing.test.ts`, `AgentMatrixClient.test.ts`, `store.test.ts` e `pi.test.ts` cobrem identidade, audiência, fila, revogação concorrente, recuperação e isolamento. O cenário `playwright/e2e/agents/shared-agent.spec.ts` usa Synapse descartável, duas instâncias do Element, E2EE real e Pi/SQLite com provider determinístico. As fixtures `shared-model.ts` e `shared-browser-agent.ts` são importadas explicitamente pelo teste; não usam credenciais reais nem o socket Firecracker. Esse teste local não acessa o laboratório.

## Nomes de implantação e estado existente

O prefixo da aplicação é `element-agents`; o worker host usa `firecracker-lab`. O Compose usa o projeto `element-agents`, e o pacote Node é `@voltdatalab/element-agents`. O frontend de exemplo mostra a marca Element Agents. Os volumes padrão acompanham o nome efetivo do projeto, inclusive quando definido por `ELEMENT_AGENTS_PROJECT_NAME` ou `-p`, para isolar instalações diferentes.

A renomeação não altera `/clawdia/agents`, `!clawdia`, a opção `clawdia_agents`, o domínio Matrix existente, MXIDs, dispositivos ou o conteúdo das conversas. Essas identidades e contratos são preservados. As variáveis novas `ELEMENT_AGENTS_ALLOWED_USERS`, `ELEMENT_AGENTS_STATE_DIR`, `ELEMENT_AGENTS_URL` e `FIRECRACKER_LAB_SOCKET` têm precedência; os nomes anteriores continuam aceitos como compatibilidade.

A imagem usa `/data` como padrão por `ELEMENT_AGENTS_DEFAULT_STATE_DIR`. Um diretório explícito em `ELEMENT_AGENTS_STATE_DIR` ou no nome anterior `CLAWDIA_STATE_DIR` tem precedência sobre esse padrão.

Trocar o nome do projeto Compose não migra volumes. Antes de reutilizar uma instalação existente, informar os nomes reais em `ELEMENT_AGENTS_STATE_VOLUME` e `ELEMENT_AGENTS_SYNAPSE_VOLUME`, com `ELEMENT_AGENTS_EXTERNAL_VOLUMES=true`. O Compose anterior gera os nomes `clawdia-element-first-slice_agents-data` e `clawdia-element-first-slice_synapse-data`. Preservar também `MATRIX_SERVER_NAME=clawdia-lab.local`; esse domínio identifica as contas existentes. A configuração mantém esse valor como padrão de compatibilidade.

O override usa o socket canônico `/run/firecracker-lab/worker.sock` dentro do container. Se o host ainda usa o diretório anterior, `FIRECRACKER_LAB_SOCKET_DIR=/run/clawdia-firecracker-lab` seleciona o bind existente sem mover o socket. A migração dos nomes dos serviços e volumes no host exige uma etapa operacional própria; editar estes arquivos não a executa.
