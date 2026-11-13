<!--
Copyright 2026 Volt Data Lab
SPDX-License-Identifier: AGPL-3.0-only
-->

# Recuperação semântica local e abstenção — ensaio sintético

## Veredito: PARCIAL

Embeddings locais melhoraram a recuperação de fontes neste conjunto pequeno. Um corte de similaridade,
calibrado separadamente, **não resolveu a decisão de haver evidência suficiente**: eliminou os candidatos
irrelevantes dos negativos, mas rejeitou quase todos os casos respondíveis. Não está pronto para produção.
Não há geração de respostas, resumos, migração de históricos, serviço novo ou integração com Matrix.

## Reproduzir

Em Linux, com Node 22.19+ e pnpm 12.11.2, na pasta deste laboratório:

```sh
corepack pnpm@12.11.2 --ignore-workspace install --frozen-lockfile --ignore-scripts
node prepareEmbeddingModel.ts
node evaluateSemantic.ts
ELEMENT_AGENTS_SEMANTIC_INTEGRATION=1 corepack pnpm@12.11.2 --ignore-workspace test
corepack pnpm@12.11.2 --ignore-workspace check
corepack pnpm@12.11.2 --ignore-workspace format:check
```

A preparação faz GETs públicos de seis arquivos, totalizando 135.139.265 bytes, e verifica tamanho/SHA-256
antes de publicá-los atomicamente no cache. Não executa código remoto. O manifesto e a revisão imutável
estão em `localEmbedding.ts`. Os pesos ficam fora do Git, em
`os.tmpdir()/element-agents-e5/<revision>`; defina `TMPDIR` para escolher uma área temporária própria.
A remoção desse cache exige repetir a preparação. Não aponte o laboratório para diretórios ou dados reais.

Depois de preparado, `evaluateSemantic.ts` aceita zero argumentos e não baixa nada: verifica os seis
arquivos antes de carregar o modelo e bloqueia fetch durante a execução. Um arquivo ausente/adulterado
causa falha, sem substituição por resultados estáticos ou vetores inventados. Não lê credenciais nem
configuração de provedores. O comando imprime JSON com fontes, versões, escores, métricas e
`COMPLETED_LOCAL_SEMANTIC_RETRIEVAL`, que significa avaliação concluída, não qualidade suficiente.

Os testes normais não precisam de rede/pesos e identificam explicitamente seus vetores de teste como
artificiais. O teste de integração real é habilitado pela variável acima, exige preparação e executa outro
processo Node com o modelo verdadeiro. A CI repete a preparação e esse teste explicitamente.

## Modelo e protocolo fixados

- Modelo ONNX: [Xenova/multilingual-e5-small](https://huggingface.co/Xenova/multilingual-e5-small),
  revisão `761b726dd34fb83930e26aab4e9ac3899aa1fa78`, `int8`, 384 dimensões.
- Runtime `@huggingface/transformers` 4.3.2, dependências transitivas no lockfile, CPU/uma thread.
- Prefixos E5 `query:` e `passage:`, pooling médio, normalização e similaridade cosseno.
- Referência do modelo: [intfloat/multilingual-e5-small](https://huggingface.co/intfloat/multilingual-e5-small).
  O upstream declara MIT; o card da conversão não declara licença própria. Pesos não são redistribuídos aqui.
- Mesmo corpus Aurora, 26 registros/24 fontes atuais, mesmas 24 consultas/gabaritos e limite de três candidatos
  dos baselines [documentados no README](./README.md). Os resultados literal/lexical permaneceram idênticos.
- O ranking recebe apenas pergunta e textos autorizados, nunca gabaritos, categoria ou resposta esperada.

A calibração foi criada independentemente do ranking e dos resultados Aurora: projeto fictício Farol,
quatro textos e oito perguntas, quatro respondíveis e quatro não respondíveis. São rótulos sintéticos,
não anotações humanas nem dados secretos de teste. O conjunto de avaliação anterior é congelado,
não um benchmark externo ou inédito.

A regra foi fixada antes de observar os resultados semânticos de Aurora: limiar igual ao maior escore
negativo de Farol mais `1e-6`. Depois disso, `semantic_local_abstain` mantém apenas candidatos acima do
limiar. Não reajustamos o corte usando os gabaritos de avaliação. A calibração é pequena e sua regra é
uma heurística conservadora, não uma probabilidade, prova de suporte factual ou garantia contra alucinação.

## Resultados efetivamente medidos, K=3

Nos 16 casos com fonte esperada permitida:

- `literal`: 6/16 (37,5%).
- `lexical`: 9/16 (56,25%).
- `semantic_local`: 15/16 (93,75%); encontrou 5/6 paráfrases e todas as quatro fontes corrigidas.
- `semantic_local_abstain`: 2/16 (12,5%); absteve-se indevidamente em 14/16 respondíveis.

Há oito casos sem fonte pertinente permitida, um deles com solicitante explicitamente negado. Nos outros
sete, a busca semântica bruta devolveu candidatos irrelevantes em todos. O corte se absteve nos sete,
mas ao custo acima. Negação de acesso é política determinística e não conta como reconhecimento de
informação ausente pelo modelo.

Em Farol, o limiar resultou em aproximadamente `0.9095464892`: zero negativos aceitos, mas somente um
dos quatro positivos preservado. Esse mau compromisso já aparecia na calibração e não foi ocultado.
Similaridade alta pode indicar apenas o mesmo assunto, sem responder ao detalhe perguntado.

Nas quatro estratégias, não houve fonte fora do escopo, versão superada, origem adulterada, divergência
de negação ou ultrapassagem do limite nas execuções normais. Isso não significa que as fontes recuperadas
respondem corretamente nem certifica a segurança da aplicação. `expectedAnswer` continua sendo apenas
gabarito; nenhum texto de resposta foi gerado pelo modelo.

O relatório inclui métricas @K globais/por categoria, precisão, fontes por caso e escores semânticos.
Mede também tempo e pico de memória do processo: neste host o ensaio levou poucos segundos após cache
preparado, com cerca de 515 MiB de pico em uma execução. Não é garantia de desempenho noutro servidor;
CPU, runtime, arredondamento numérico e tamanho dos textos podem alterar custos/escores.

## Fronteiras preservadas

- `MemoryLab.search` limita a visão antes de qualquer codificação: notas privadas não entram no lote compartilhado.
- O encoder é stateless: pesos comuns não são uma memória global de conversas. Não há índice vetorial global,
  cache de textos entre DMs, sessão generativa ou persistência de embeddings.
- Autorização e atualidade das fontes são revalidadas depois do `await` de inferência. O avaliador também
  revalida consultas anteriores antes de devolver o relatório consolidado.
- Há regressões para turno forjado, mudança de autorização e fonte corrigida durante inferência; embeddings
  inválidos e falhas do modelo são erros, não “informação ausente”.
- Farol usa um SQLite separado; Aurora usa somente `:memory:`. Relatórios agregados pertencem ao controle
  confiável do experimento sintético: não devem virar endpoint de agentes nem ser produzidos a partir de DMs reais.

## Próxima conclusão de engenharia

Manter a busca semântica como geradora de candidatos, mas não usar seu escore sozinho para autorizar uma
resposta factual. O próximo ensaio deve verificar suporte entre pergunta, trecho e eventual afirmação,
preservando fontes e a recusa quando o detalhe não aparece. Não há evidência para adotar este corte,
construir uma árvore de resumos ou importar históricos em produção.

O [ensaio seguinte de leitura extrativa citada](./EVIDENCE.md) já mede uma opção nula explícita, sem
ajustar o corte aos gabaritos, e mostra limites adicionais de relevância/completude. Modelos geradores
e integração real continuam dependendo de escopo/orçamento próprios.
