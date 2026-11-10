# Criação de agentes Pi no Element

Primeira fatia da [direção da ClawdIA](https://github.com/fmercurio/claw-tenant/issues/167), acompanhada na [issue 1 deste fork](https://github.com/voltdatalab/element-web/issues/1).

O menu **Criar agente** abre um formulário de nome e descrição. O serviço autentica o dono pela sessão Matrix, provisiona um usuário de bot e uma DM privada criptografada, abre uma conversa Pi Durable e devolve a sala. O Element entra na sala e registra a DM. Novas mensagens do dono são admitidas em uma fila persistente, processadas pelo Pi e respondidas com transação Matrix estável.

A revisão inicial usa Pi Durable 1.5.2, um provider OpenAI e o modelo da variável `PI_MODEL`. As ferramentas de shell e arquivos pertencem à fatia Firecracker posterior. O estado Pi, a identidade Matrix e as credenciais ficam no serviço.

## Executar o serviço

Usar Node 22.19 ou superior e as dependências do workspace instaladas. Configurar no ambiente do serviço as seguintes variáveis.

| Variável                | Uso                                                                        |
| ----------------------- | -------------------------------------------------------------------------- |
| `MATRIX_HOMESERVER`     | URL fixa do Synapse da instalação.                                         |
| `MATRIX_SERVER_NAME`    | Domínio dos IDs Matrix desse servidor.                                     |
| `MATRIX_ADMIN_TOKEN`    | Credencial de provisionamento de usuários do Synapse, restrita ao backend. |
| `CLAWDIA_ALLOWED_USERS` | MXIDs autorizados a criar agentes, separados por vírgula.                  |
| `OPENAI_API_KEY`        | Credencial do modelo da instalação.                                        |
| `PI_MODEL`              | ID do modelo no catálogo Pi fixado.                                        |
| `CLAWDIA_STATE_DIR`     | Diretório privado persistente, padrão `./state`.                           |
| `HOST` / `PORT`         | Bind do serviço, padrão `127.0.0.1:8787`.                                  |

```sh
pnpm --filter @voltdatalab/clawdia-agents start
```

O diretório de estado usa permissões privadas e lock com heartbeat para um único processo escritor. Ao reiniciar, o serviço recupera cadastros, credenciais dos dispositivos, salas, conversas Pi e mensagens pendentes. Uma requisição de criação repetida conserva sua chave e seu corpo. O navegador guarda esse rascunho por usuário na sessão da aba até conseguir abrir a DM.

Ativar `clawdia_agents` no `config.json` do Element e rotear `/clawdia/` na mesma origem para o serviço. Em desenvolvimento, `CLAWDIA_AGENTS_URL` configura o proxy do servidor web. A API recebe o access token Matrix da sessão pelo cabeçalho Authorization e consulta `whoami` no homeserver configurado. O corpo do formulário fornece nome e descrição.

## Laboratório no nucleotech-02

O compose tem nome, rede, volumes e portas próprios. Publica Synapse em `127.0.0.1:18008` e a API em `127.0.0.1:18787`. Preparar a configuração do Synapse uma vez, a partir de `apps/agents`.

```sh
docker compose run --rm -e SYNAPSE_SERVER_NAME=clawdia-lab.local -e SYNAPSE_REPORT_STATS=no synapse generate
docker compose up -d synapse
```

Criar o usuário de laboratório pelo `register_new_matrix_user` do Synapse e obter sua credencial administrativa para `MATRIX_ADMIN_TOKEN`. Guardar as variáveis acima em `.env` local, protegido, e então executar `docker compose up -d --build agents`. O admin token pertence somente a este homeserver de laboratório. As portas de loopback podem ser acessadas por túnel SSH.

O arquivo `element.config.example.json` configura o cliente para esse laboratório. O serviço web em desenvolvimento pode usar `CLAWDIA_AGENTS_URL=http://127.0.0.1:18787`. Para validar o produto, criar o agente pela interface, enviar uma mensagem na DM e reiniciar o serviço, verificando a continuidade da conversa e da mesma sala.

## Verificação

Os testes do store cobrem repetição, conflito e recuperação de provisionamento/fila. O teste Pi usa harness e SQLite reais com provider determinístico. Os testes HTTP verificam identidade, acesso, tamanho de entrada e ausência de segredos na resposta. Os testes do view model e do formulário cobrem abertura, erro, recarga e submissão repetida. O Playwright cobre o fluxo de interface com resposta de provisionamento controlada.

Uma resposta de LLM e uma DM real no laboratório constituem verificações adicionais, registradas na issue com ambiente e versão. O provider determinístico comprova a integração persistente do harness.

Para repetir os testes integrados, usar um arquivo privado do usuário de laboratório com `user_id`, `password` e `access_token`, e definir `CLAWDIA_MATRIX_TEST_CREDENTIALS` com seu caminho. `CLAWDIA_MATRIX_TEST_URL` seleciona o Synapse, com padrão de loopback na porta 18008.

```sh
CLAWDIA_MATRIX_TEST_CREDENTIALS=/caminho/privado/usuario-lab.json node --test --test-force-exit apps/agents/src/matrix.integration.test.ts
BASE_URL=http://127.0.0.1:8088 CLAWDIA_MATRIX_TEST_CREDENTIALS=/caminho/privado/usuario-lab.json pnpm --filter element-web exec playwright test playwright/e2e/agents/live-onboarding.spec.ts --project=Chrome --ignore-snapshots
```

O teste de processo usa o provider determinístico por importação explícita da fixture. O teste de navegador requer uma API de laboratório iniciada com a mesma fixture, em estado separado. De `apps/agents`, com as demais variáveis Matrix configuradas, esse processo pode ser iniciado assim.

```sh
NODE_ENV=test PI_MODEL=faux-1 OPENAI_API_KEY=integration-fixture-unused node --import ./src/fixtures/faux-model.ts src/server.ts
```

A fixture exige `NODE_ENV=test`. O comando normal do serviço usa o provider configurado no código, e a prova com modelo real precisa ser registrada separadamente.
