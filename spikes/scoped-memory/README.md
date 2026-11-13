<!--
Copyright 2026 Volt Data Lab
SPDX-License-Identifier: AGPL-3.0-only
-->

# Memória com escopos — laboratório sintético

**Experimental, independente da aplicação e sem LLM.** Esta primeira etapa verifica fronteiras de acesso,
proveniência e persistência. Não implementa Siesta/OptMem, busca semântica ou compactação por IA.

## Executar

Requer Node.js com execução nativa de TypeScript e `node:sqlite` (Node 22.19 ou superior).
Validado localmente com Node 22.23.2 e pnpm 12.11.2. O job `scoped-memory` usa Node 26.7.0.

A demonstração não tem dependências de runtime e pode ser executada da raiz do checkout:

```sh
node spikes/scoped-memory/run.ts
```

Ela cria somente um banco em memória, executa asserções e imprime JSON com `PASS_OFFLINE_SYNTHETIC`
se todas passarem. Aceita zero argumentos: não abre um banco de produção nem carrega configurações,
credenciais, endpoints, mensagens ou arquivos de usuários.

Para instalar apenas as ferramentas deste laboratório e repetir as verificações:

```sh
cd spikes/scoped-memory
corepack pnpm@12.11.2 --ignore-workspace install --frozen-lockfile --ignore-scripts
corepack pnpm@12.11.2 --ignore-workspace check
corepack pnpm@12.11.2 --ignore-workspace test
corepack pnpm@12.11.2 --ignore-workspace format:check
node run.ts
```

O pacote não pertence aos workspaces de produção. `--ignore-workspace` é necessário para usar este
`pnpm-lock.yaml`, sem instalar ou alterar as dependências do monorepo. Se Corepack não estiver disponível,
provisione pnpm **12.11.2** no ambiente de desenvolvimento e use `pnpm --ignore-workspace ...`.
A instalação das ferramentas requer acesso ao registro de pacotes; os testes e a demonstração não
requerem rede, conta de provedor ou chave de API.

No Node 22, `node:sqlite` emite um aviso de funcionalidade experimental. O aviso não é falha de teste.
Os testes de reabertura criam e removem um diretório próprio sob `os.tmpdir()`; defina `TMPDIR` se quiser
escolher uma área temporária. Nunca aponte esta classe experimental para bases reais.

## O que foi validado

- 24 notas inventadas em quatro compartimentos: DM A, DM B, projeto compartilhado e base restrita.
- Matriz explícita de 32 combinações entre conversa, agente e solicitante, incluindo acessos negados.
- Dois agentes consultam o projeto comum sem receber a memória da DM do outro.
- Leitura restrita à interseção entre agente, solicitante, audiência inteira e escopos da conversa.
- DM vinculada ao destino, dono e agente originais, mesmo após revogação e reabertura.
- Banco consultado por partição autorizada, antes de buscar os corpos das notas.
- Resultados imutáveis, vinculados ao turno e rejeitados quando clonados, forjados ou reaproveitados em outro turno.
- Mudanças de audiência ou autorização invalidam turnos antigos, inclusive depois de restaurar o acesso.
- Nova conferência de acesso imediatamente antes da entrega síncrona de texto a um callback de teste.
- Notas por acréscimo, com fonte e versão; correções explícitas substituem fontes antigas nas consultas.
- Derivados preservam o escopo e os vínculos de origem; não podem misturar compartimentos.
- Correções invalidam derivados transitivamente e impedem entregar resultados preparados com fontes superadas.
- Reabertura do SQLite preserva notas e política, mas não aceita os identificadores de turno da instância anterior.
- Consultas com aparência de SQL são texto literal; conteúdo com instruções não altera a política determinística.
- Demonstração exercitada em um processo Node novo, sem carregador TypeScript externo.

A suíte passou com **54 testes**, incluindo os 32 casos da matriz. `check` verifica os tipos;
`format:check` usa Oxfmt. O comando de demonstração possui asserções próprias e saída derivada da execução,
não uma resposta de modelo nem um relatório estático de aprovação.

## Contrato e fronteira de confiança

`MemoryLab` é um serviço de teste em processo, não uma API de autenticação. `setScope`, `setConversation`,
`addNote` e `createDigest` são operações do **controle de fixtures confiável**. Não devem ser expostas a agentes
ou a clientes. A identidade autenticada e a audiência real teriam de vir da aplicação numa integração futura.

`beginTurn` recebe o destino registrado, o agente e o solicitante; não aceita uma audiência ou uma lista de
escopos fornecidas na pergunta. `search` só consulta as partições autorizadas. `dispatch` revalida o turno,
a identidade do resultado e a validade das fontes antes de chamar um callback síncrono com uma string.
Não executa uma entrega Matrix ou uma inferência. Erros de autorização não expõem conteúdo de fontes.

`createDigest` apenas combina textos de origens do mesmo escopo para exercitar herança de permissões e
invalidação. **Não é resumo semântico, compressão de contexto nem evidência de economia de tokens.**
Derivados não aceitam correções por `addNote` com `supersedes`; devem ser reconstruídos por `createDigest`
a partir de origens atuais.
Uma nova versão deve apontar explicitamente para a nota que substitui; não se infere a decisão correta
apenas pela data ou por similaridade do texto.

## Limites e próximo teste

Este resultado valida o mecanismo determinístico nestas fixtures, não certifica segurança do produto.
Não cobre modelo obedecendo instruções maliciosas, qualidade de recuperação por paráfrase, respostas
factuais, redução de tokens, carga, armazenamento adulterado, múltiplos escritores ou cancelamento de
entrega distribuída. Material já devolvido antes de uma revogação não pode ser retirado da memória de
um consumidor; uma integração futura precisa invalidar também seus contextos/caches e conferir acesso
no despacho ao provedor e na entrega real.

O banco de teste não tem criptografia de conteúdo nem política de expurgo. A política e o processo do
laboratório são confiáveis; isto não é sandbox para executar código hostil. Não há autorização para reutilizar
uma sessão que já recebeu conteúdo privado numa audiência diferente.

Próxima etapa: comparar recuperação simples e recuperação apoiada por resumos, mantendo estas mesmas
fronteiras e um conjunto de respostas esperadas. A fase com LLM e qualquer integração com produção
precisam de escopo e orçamento próprios.

Este diretório não é importado pela API, não altera APIs/identidades existentes, não lê volumes de DMs,
não publica anexos e não controla Synapse, CapRover ou Firecracker. A sala compartilhada existente permanece
inalterada e somente texto. Nenhum deploy é necessário para reproduzir o laboratório.
