<!--
Copyright 2026 Volt Data Lab
SPDX-License-Identifier: AGPL-3.0-only
-->

# Respostas extrativas citadas e decisão nula — laboratório sintético

## Veredito: PARCIAL, não pronto para responder em produção

Este ensaio acrescenta um leitor à busca semântica: extrai um trecho literal de uma fonte autorizada ou
se abstém. A opção nula reduziu respostas sem evidência, mas ainda houve escolhas irrelevantes.
Uma citação auditável não prova que o trecho responde à pergunta. Não há geração livre, resumo,
chamada de provedor, leitura de DM real ou integração com Matrix/API.

## Executar e reproduzir

Requer Linux e Node com TypeScript nativo/SQLite (22.19+; validado neste host com 22.23.2).
Dentro de `spikes/scoped-memory`:

```sh
corepack pnpm@12.11.2 --ignore-workspace install --frozen-lockfile --ignore-scripts
node prepareEmbeddingModel.ts
node prepareQAModel.ts
node evaluateEvidence.ts
ELEMENT_AGENTS_EVIDENCE_INTEGRATION=1 ELEMENT_AGENTS_SEMANTIC_INTEGRATION=1 corepack pnpm@12.11.2 --ignore-workspace test
corepack pnpm@12.11.2 --ignore-workspace check
corepack pnpm@12.11.2 --ignore-workspace format:check
```

As preparações são explícitas: GETs de artefatos públicos fixados por revisão, bytes e SHA-256, sem textos
ou credenciais nas requisições. O helper compartilhado `modelArtifacts.ts` valida os identificadores e
caminhos antes do I/O e publica somente arquivos completos/verificados, usando rename atômico.
Os pesos ficam fora do Git: `os.tmpdir()/element-agents-e5/<revision>` e
`os.tmpdir()/element-agents-qa/<revision>`. Defina `TMPDIR` para escolher uma área temporária própria.
Caches e controle de fixtures são confiáveis; isto não é uma sandbox contra outro processo com acesso à conta.

`evaluateEvidence.ts` aceita zero argumentos, usa SQLite `:memory:`, verifica os pesos e bloqueia fetch.
Arquivos ausentes/adulterados e erros de modelo causam falha: não há download automático ou resultados
fictícios de substituição. Os testes normais usam doubles explicitamente artificiais; as flags acima
habilitam processos com os modelos reais. A CI prepara ambos e executa as integrações separadamente.
O status `COMPLETED_LOCAL_EXTRACTIVE_EVIDENCE` significa ensaio concluído, não respostas confiáveis.

O compilador é o TypeScript oficial **6.0.3**, fixado no lockfile e chamado por caminho local no script
`check`; um teste confere a versão real. Isso evita resolver um `tsc` global ou confundir a versão do
antigo pacote-ponte com a do compilador que ele carregava. Nenhuma ferramenta global é modificada.

## Modelos e critério fixos

- Recuperação: o mesmo E5 int8 da [etapa semântica](./SEMANTIC.md), mesmos gabaritos Aurora e K=3.
- Leitor: [onnx-community/mdeberta-v3-base-squad2-ONNX](https://huggingface.co/onnx-community/mdeberta-v3-base-squad2-ONNX),
  revisão `2ff2ab03627f6f3e83c3570d8c937caee33b47b5`, int8, seis arquivos/333.452.643 bytes.
- [Upstream timpal0l/mdeberta-v3-base-squad2](https://huggingface.co/timpal0l/mdeberta-v3-base-squad2):
  base multilíngue, ajustada em SQuAD2 em inglês; declara MIT. A conversão não declara licença própria.
  Não inferimos qualidade em português a partir dos resultados publicados em inglês; medimos aqui.
- Transformers.js 4.3.2/ONNX CPU, uma thread por modelo; nenhum decoder generativo.

O pipeline pronto de question-answering desta versão da biblioteca zera a opção CLS e devolve um span.
Por isso, `localQuestionAnswering.ts` usa logits brutos e `qaSpan.ts` implementa a comparação explícita:

1. Considerar somente tokens do segmento de contexto, sem pergunta, padding ou especiais.
2. Escolher o maior `startLogit + endLogit`, início <= fim, com até 32 tokens.
3. O nulo é `startLogit[0] + endLogit[0]`, na primeira posição especial.
4. Entre os três trechos recuperados, escolher a maior margem `spanScore - nullScore`.
5. `extractive_forced` tenta devolver o span; `extractive_null` só o aceita se a margem for **> 0**.

Não há softmax, probabilidade de verdade, corte ajustado em Aurora ou nova calibração. Farol é apenas
um controle independente com quatro textos e oito perguntas, sem retriever, observando a regra já fixa.
Rótulos de respondibilidade e respostas esperadas nunca são enviados a encoder ou leitor.

Os tokens decodificados devem aparecer literalmente na fonte. Só então são criados os offsets JS,
a citação e os identificadores/versões autoritativos. Se não houver mapeamento literal, o estado é
`unmapped_span`, não reconhecimento de ausência. O texto original não é normalizado para publicação.

## Resultados efetivamente medidos

A busca continuou encontrando a fonte esperada em **15/16** positivos. Esse número mede recuperação,
não extração de uma resposta. Em Aurora, das 16 consultas respondíveis:

- Forçar o leitor produziu 16 respostas e cinco coincidências exatas com texto **e fonte** do gabarito.
- A opção nula produziu 15 respostas, uma abstenção positiva e as mesmas cinco coincidências exatas
  (5/16, 31,25%). A média de F1 lexical vinculada à fonte foi aproximadamente 0,5336 nos dois modos.
- Dos sete negativos avaliáveis, forçar produziu sete respostas sem suporte. O nulo reconheceu ausência
  em quatro, mas ainda respondeu em três. Um oitavo negativo é solicitante explicitamente negado,
  sem inferência, e não conta como acerto do modelo.
- No controle Farol, o modo nulo aceitou os quatro positivos e respondeu indevidamente em dois dos
  quatro negativos. Aceitar um positivo nesse controle não demonstra que o span escolhido está correto.

Os erros incluem trechos realmente irrelevantes, não apenas diferenças de redação: à pergunta sobre
como deve ser a peça apresentada, o leitor escolheu “planta”; à pergunta sobre liderança após troca,
escolheu “Aurora”, embora a nota atual contivesse a pessoa correta. Ambas eram citações literais de
fontes permitidas. O erro de orçamento por paráfrase também inclui uma falha de recuperação: a fonte
esperada não estava entre as três disponíveis ao leitor.

Outras não coincidências são respostas parciais: “painel dobrável com três abas” difere do gabarito
“um painel dobrável com três abas”. **Não tratamos 5/16 como contagem definitiva de respostas factualmente
corretas**, nem F1 como probabilidade de correção. Seis consultas foram herdadas da busca literal e são
fragmentos, não perguntas completas; o relatório separa categorias para expor essa limitação.

EM/F1 são calculados apenas nos positivos, com zero para abstenção ou fonte errada. A normalização é
somente para scoring: NFC, minúsculas, pontuação/espaços; preserva acentos, negação, sinais numéricos,
percentuais e separadores internos de números. F1 conta multiplicidade de palavras. Não agrega negativos
ou negações de acesso numa “acurácia geral” que esconderia erros de resposta.

## Fronteiras e limites

- Escopo/audiência são conferidos antes de encodificar ou ler. O leitor recebe apenas pergunta e uma nota autorizada.
- Revalidação após cada await e dos snapshots anteriores antes de entregar o relatório consolidado.
- Citações são literais, com nota, escopo, fonte, versão e offsets. O modelo não escolhe metadados de autorização.
- Saídas são copiadas para impedir que a reutilização de um objeto do provider altere uma citação já validada.
- Nenhuma fonte proibida, superada ou adulterada foi entregue nas execuções normais. Permaneceram erros de utilidade,
  inclusive respostas irrelevantes a pedidos adversariais: não são vazamento, mas também não são boas recusas.
- Relatórios agregados são do controle confiável do experimento sintético, não um endpoint ou sessão de agente.

A suíte passou com **390 testes**, incluindo as duas integrações reais, e o check local pinado/Oxfmt.
Uma execução neste host usou cerca de 1,22 GiB de pico e poucos segundos com os caches preparados;
isso não é garantia de desempenho em outra CPU/runtime. Escores numéricos podem variar entre ambientes.

O próximo problema não é comprimir históricos: é validar relevância e completude da resposta com um
conjunto de perguntas naturais e critérios de suporte explícitos. Este leitor específico não deve ser
ligado aos agentes como verificador final. A restauração da plataforma inteira e qualquer uso de dados
reais, modelos geradores ou produção continuam fora deste laboratório.
