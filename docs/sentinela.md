# Sentinela: moderação consultiva no aparelho

Proposta de desenho para "sentinelas", modelos pequenos que rodariam dentro do app Varanda para (a) avisar quem escreve, antes de publicar, que o texto ou a imagem parece contrariar os Termos, e (b) sinalizar localmente o que chega e ajudar a pessoa a denunciar. O documento explora candidatos, ameaças, desenho e custos, e lista o que a manutenção precisa decidir. Ele propõe; não muda regra nenhuma.

## 1. Estado

- **Proposta.** Nada foi entregue. Nenhuma tela, nenhum modelo e nenhuma dependência nova estão na `main`.
- **A regra de `AGENTS.md` continua valendo:** "Não leve inferência para o aparelho nem para o processo que guarda a chave do emissor". Enquanto a manutenção não mudar essa regra (seção 13), nada deste documento entra no app de produção.
- **A branch tem dois tipos de commit:** os de documentação (este arquivo e a linha em `docs/README.md`) e os de spike, só para desenvolvimento: o módulo nativo `apps/app/modules/sentinel-spike` com ONNX Runtime (no iOS, pods `onnxruntime-c` e `onnxruntime-objc` 1.21.0 no `apps/app/ios/Podfile.lock`; no Android, `com.microsoft.onnxruntime:onnxruntime-android` 1.21.1, porque a biblioteca JNI da 1.21.0 (`libonnxruntime4j_jni.so`) não vem alinhada a páginas de 16 KB), os arquivos do bench em `apps/app/src/sentinel/` (helpers, fixture e o executor `runBench.native.js`, com um irmão `runBench.web.js` vazio), o gancho só de desenvolvimento em `apps/app/index.js`, os testes `apps/app/test/sentinelBench.test.js` e `sentinelSpikeModule.test.js`, a linha do podspec em `apps/app/test/hardening.test.js`, o script `apps/cli/scripts/sentinel-fixture.js` e, do spike 2, `apps/app/src/sentinel/nliFixture.json` e os scripts `apps/cli/scripts/sentinel-nli-fixture.js`, `sentinel-nli-eval.js` e `sentinel-nli-eval-set.json`. Só os commits de documentação são propostos para a `main`. Juntar o spike à `main` acrescentaria uma dependência nativa a todos os builds de release, porque `apps/app/modules` é autolinkado.
- **O spike** (seção 12) roda só em build de desenvolvimento, por decisão explícita do mantenedor, nessa branch. Ele mede custo (carga, latência, memória, tamanho) e paridade com o servidor; não mede qualidade de moderação e não tem tela para a pessoa usuária.
- **O spike 2** testa o caminho NLI zero-shot (seção 7, T-h), o que mais se aproxima do Jev rodando no aparelho, porque o Jev só existe hospedado (T-i). A acurácia em pt-BR se mede no Node com os mesmos pesos (seção 8); o simulador e o emulador conferem paridade dos logits, carga, latência e memória (seção 12). Mesmas travas do spike 1: só build de debug, modelo copiado à mão, nada baixado pelo app. Resultado até aqui: com hipóteses fixas, o NLI zero-shot é fraco em pt-BR e serve no máximo de sinal auxiliar ao lado do embedding com cabeça treinada (seção 8).
- Fatos de modelos e bibliotecas foram conferidos nas páginas oficiais em 15/11/2026 (seção 16). O que não deu para conferir diz "a conferir". Números de desempenho do app dizem "a medir" até o spike rodar em aparelho. No simulador iOS e no emulador Android ele já rodou (seção 12): provou carga, paridade (cosseno 1,00 contra o servidor) e liberação de memória, não latência de celular.

## 2. Pedido e decisões já tomadas

O pedido: explorar modelos no aparelho que (a) avisem a autora antes de publicar conteúdo que quebra os Termos e (b) marquem localmente conteúdo recebido e ajudem a abrir uma denúncia.

O mantenedor já decidiu:

1. **A entrega é este documento mais um spike medido.** Nada de produto nesta etapa.
2. **A autoridade é só consultiva.**
   - Antes de publicar: a sentinela avisa; a autora pode publicar mesmo assim.
   - Na entrada: desfoque ou recolhimento local, com "ver mesmo assim", e uma denúncia de um toque que entra na triagem de hoje (pessoa mais servidor).
   - Um veredito do aparelho nunca bloqueia uma chave e não tem peso nenhum no servidor.

O resto (superfícies, categorias, modelo, entrega dos pesos, licenças) está aberto e listado na seção 14.

## 3. O que existe hoje

- **Conferência de palavras** (`apps/app/src/wordCheck.js`): recusa texto público com um termo de `apps/app/src/blockedTerms.js`, comparando palavras inteiras dobradas. O cabeçalho diz que ela não faz "no request, no counter, no log and no record of a refusal" e que mensagens diretas e grupos privados "never reach it". A recusa é dura: o rascunho fica, sem botão de publicar mesmo assim (`docs/design.md`, "Conferência de palavras no aparelho"). Em `Publicar.js` ela roda antes de qualquer caminho (`const refused = refusalOf(text)`, :321) e não roda de novo numa publicação assinada esperando reenvio (`pageRetryRef.current === null ? refusalOf(text) : ''`, :1348). Os Termos já a descrevem (`apps/app/src/legal.js`:63, "recusam, no próprio aparelho e antes de publicar ou enviar").
- **Denúncias assinadas** (`packages/core/lib/report.js`): motivos `REASONS = Object.freeze(['spam', 'assedio', 'ilegal', 'outro'])` (:61), observação de até 280 caracteres, trecho citado. No app, `apps/app/src/screens/Denunciar.js` monta a tela e `apps/app/src/report.js` os pedidos (`buildReportStart`, `buildReportSend`, e as variantes de mensagem direta e de anúncio). Só funcionam na web hospedada e no app ligado à instalação, com a conta vinculada (`apps/app/src/legal.js`, seção "Convivência e denúncias": "As denúncias funcionam na versão web hospedada"). O serviço de conta aceita no máximo 20 denúncias por pessoa por dia (`MAX_PER_REPORTER_DAY = 20`, `apps/cli/lib/account/moderation-store.js`:102) e responde a mesma linha para uma denúncia aberta repetida da mesma pessoa contra a mesma publicação, com mesmo alvo, `seq`, escritor e anexo ("A retry of an add that already landed answers the same row"). Denúncias de pessoas diferentes contra a mesma publicação são linhas separadas; se o painel as agrupa, a conferir.
- **Triagem no servidor** (`apps/cli/lib/account/ai/`): o embedder MiniLM roda num processo filho com ambiente vazio, e `triage.js` só decide sozinho `spam` (`BLOCK_REASONS = Object.freeze(['spam'])`), com cosseno alto, votos de 5 diários distintos entre os precedentes humanos (`K = 5`) e tetos diários (`MAX_AI_BLOCKS_PER_DAY = 20`). As entradas da regra são o vetor do texto verificado no semeador e os precedentes humanos: o número de denúncias contra a publicação não entra na conta. `ilegal`, `assedio`, denúncia de conta, publicação com mídia ou citação e apelação vão sempre a uma pessoa. `docs/design.md`:391 explica por que não roda no aparelho: "um veredito calculado no aparelho poderia ser forjado por um app modificado".
- **Bloqueio pessoal:** cada pessoa esconde quem bloqueou. No núcleo, `buildFeed` recebe `hidden` ("the member's own blocks", comentário de `buildFeed` em `packages/core/lib/feed.js`, usado no laço das republicações); na tela, `blockedRowView` (`apps/app/src/memberBlocks.js`, chamado em `apps/app/src/ui/PostRow.js`:799) some com a linha ou marca a citação como indisponível.
- **Mídia:** nenhuma checagem. `docs/protocol.md` lista entre os limites conhecidos "there is no matching against hash lists of known illegal content", e `docs/design.md` repete que a IA não vê imagens e que a comparação com listas de hashes (issue #79) não existe.

## 4. Modelo de ameaças

**(a) Veredito forjado.** Um app modificado diz o que quiser sobre o que leu ou escreveu. Por isso nenhum veredito, pontuação, rótulo ou marca "sentinela" chega ao servidor ou pesa nele. A denúncia assistida é uma denúncia comum, com os mesmos campos assinados de `report.js`, o mesmo teto diário e a mesma triagem. O servidor não sabe, e não deve poder saber, que uma sentinela sugeriu a denúncia.

**(b) Repositório e pesos públicos.** Quem quer contornar baixa o app, extrai os pesos e testa variações offline até passar. A sentinela pega só abuso pouco sofisticado: a pessoa que não sabe que está passando do ponto, o insulto escrito no impulso, o spam copiado sem cuidado. Não é barreira contra quem se esforça, e o documento não deve prometer isso.

**(c) Uso como arma.** Um texto ou uma imagem adversarial pode ser feito para que aparelhos honestos marquem a publicação de uma vítima e, com um toque, a denunciem em massa. Mitigações que já existem: o teto de 20 denúncias por pessoa por dia (`MAX_PER_REPORTER_DAY = 20`, `apps/cli/lib/account/moderation-store.js`), a resposta única para a denúncia aberta repetida da mesma pessoa contra a mesma publicação (mesmo alvo, `seq`, escritor e anexo) e, principalmente, a regra de que `triage.js` não decide sozinho `assedio` nem `ilegal`. O volume de denúncias não pesa na triagem: as entradas de `triage.js` são o vetor do texto verificado no semeador e os precedentes humanos, então cem denúncias contra a mesma publicação não valem mais que uma para a IA. Três agravantes:

- **Várias contas.** O teto é por pessoa que denuncia: N contas dão N vezes 20 denúncias por dia. O custo de uma conta que denuncia, segundo `docs/design.md`, é uma passkey, a verificação de idade antes de a identidade valer na rede, o certificado de membro da associação, a conta vinculada (para membro novo, o `sub` é `telefone:` mais a chave; o Google não é mais coletado) e, quando `VARANDA_PHONE_KEY` está definida, um celular brasileiro (`+55`) confirmado por SMS, um número por membro ("Verificação de celular"). Com `VARANDA_INVITES_PER_WEEK`, também um convite. A sentinela não muda esse custo, mas torna mais barato para cada conta escolher o alvo.
- **`spam` é o único motivo que a IA bloqueia sozinha** (`BLOCK_REASONS = Object.freeze(['spam'])` em `triage.js`). Se a sentinela pré-selecionasse `spam`, uma isca bem feita empurraria denúncias justamente para o único caminho automático. Recomendação: a sentinela nunca pré-seleciona `spam`; a pessoa escolhe o motivo (seção 14, item 19).
- **A isca gasta o teto de quem é honesto.** Cada denúncia assistida sai do teto diário da própria pessoa. Uma onda de iscas pode esgotar as 20 denúncias do dia de quem está sendo assediado de verdade, que fica sem poder denunciar o que importa. Mais um motivo para o toque ser sempre deliberado e para a sentinela não sugerir denúncia em toda linha marcada.

Mitigações a desenhar: o toque é sempre da pessoa (nunca automático), a sentinela não sugere motivo para conteúdo de quem a pessoa segue há tempo (a decidir), e o painel deveria mostrar um surto de denúncias contra a mesma chave como surto, não como prova. Um efeito colateral: denúncias assistidas aumentam o volume que chega às pessoas da moderação.

**(d) Envenenamento de precedentes.** As decisões humanas viram precedentes da triagem (`docs/design.md`, "Só uma decisão humana vira precedente"). Se a sentinela empurra muitas denúncias parecidas e a moderação, cansada, decide em lote, essas decisões ensinam a triagem do servidor. A defesa atual (votos de 5 diários distintos entre os precedentes, margem, só `spam` decide sozinho, lista "sempre humano") continua; a proposta não afrouxa nenhuma constante de `triage.js`. Vale a manutenção acompanhar no Histórico se a taxa de bloqueio muda depois de ligar a sentinela.

**(e) Varredura de conversa cifrada.** A posição do projeto está em `wordCheck.js` ("checking inside encrypted chat reads as scanning private messages, even with nothing sent anywhere") e nos Termos (`legal.js`:57, a autorização de uso "não alcança o conteúdo cifrado das mensagens diretas e dos grupos privados, exceto o que alguém enviar numa denúncia"). A proposta mantém mensagens diretas e grupos privados fora por padrão (seção 5); qualquer desfoque opcional ali é decisão da manutenção (seção 14, item 2).

**(f) Exposição de quem denuncia.** Uma denúncia conta à associação o que a pessoa estava lendo e quando. Uma denúncia automática faria isso sem a pessoa decidir, para cada linha marcada. Por isso a denúncia exige sempre um toque explícito e uma confirmação da tela de `Denunciar.js`.

**(g) Falso positivo e viés em pt-BR.** Classificadores de toxicidade erram de modos conhecidos: termos reapropriados por grupos (falados pelo próprio grupo), gírias regionais, citar um insulto para condená-lo, relato de violência sofrida, termos de identidade em frase neutra ("sou gay e moro na Zona Leste"). O próprio card do Detoxify avisa que palavrões levam a classificar como tóxico "regardless of the tone or the intent of the author" (seção 16). Um aviso errado na hora de publicar é uma acusação feita pelo app. A seção 8 propõe medir isso antes de qualquer entrega.

**(h) Cadeia de suprimentos.** Os pesos entram como o servidor já faz em `embedder.js`: revisão fixa (`MODEL_REVISION`) e sha256 de cada arquivo (`FILES`, `PIN`), conferidos antes de carregar. Licenças dos pesos, do tokenizador e do runtime precisam caber na PolyForm Noncommercial 1.0.0 (seção 14). O runtime nativo lê só arquivos fixados, nunca uma URL. Imagens de pares são não confiáveis e passariam por um pré-processador (decodificação, redimensionamento) que é superfície de ataque própria: usar o decodificador do sistema, com limite de dimensões antes de decodificar, e nunca uma biblioteca de imagem nova sem decisão.

**(i) Bateria, calor e RAM.** O piso do Android é `minSdkVersion` 31 (`apps/app/android/gradle.properties`); há aparelhos de entrada com Android 12 e 3 a 4 GB de RAM. Um modelo de 100 MB carregado junto com o worklet do nó pode empurrar o app para ser morto em segundo plano. A seção 11 limita quando carregar e quando descarregar.

**(j) Sem telemetria.** `AGENTS.md`: "Não acrescente coleta de dados, rastreio ou telemetria". A qualidade em campo não é medível: não haverá contagem de avisos, de "publicar mesmo assim" nem de falsos positivos. A qualidade se mede só antes, com os conjuntos da seção 8, e pelo que as pessoas relatarem por conta própria.

**(k) Registro do que a pessoa leu.** O cache de vereditos da entrada (seção 5) é um registro em repouso de quais publicações a pessoa viu e quais a sentinela marcou. Quem pega o aparelho destravado, um backup ou outro script da mesma origem na web consegue ler esse histórico. Regras propostas: tamanho limitado (por exemplo as últimas algumas centenas de linhas, a decidir), validade curta (horas ou poucos dias, a decidir), apagado ao sair e ao excluir a conta junto com os outros dados locais, nunca sincronizado entre aparelhos nem enviado a lugar nenhum, e chave por um digest com sal local (`(autora, seq)` em claro identifica a publicação). Fica fora do backup do sistema quando a plataforma deixar (a conferir por plataforma). Na web, onde o armazenamento da origem é mais exposto, a alternativa é não guardar cache nenhum e recalcular (seção 14).

## 5. Desenho

**Onde roda a inferência.** Num módulo nativo Expo (Swift e Kotlin, em `apps/app/modules/`), chamado pela interface React Native. Nunca no worklet Bare: o worklet é o nó, guarda a chave do diário e passa por `apps/app/scripts/check-bundle.js`, que recusa qualquer built-in do Node no pacote; um runtime de ML ali misturaria código nativo de terceiros com o processo da chave, o que a regra de `AGENTS.md` quer evitar. Nunca por um método RPC novo: o nó não precisa saber que a sentinela existe, e `docs/rpc.md` não muda.

**Antes de publicar.**

- A sentinela roda depois da recusa de `wordCheck`, nos mesmos pontos de chamada (os que já chamam `refusalOf`). Se `wordCheck` recusa, a sentinela nem roda.
- Se a sentinela marca o texto, aparece um aviso com o motivo em linguagem simples, "Editar" (padrão) e "Publicar mesmo assim". Nada é contado nem registrado.
- Não reavisa no caminho de reenvio: uma publicação já assinada esperando a fila de saída (`apps/app/src/outboxProvider.js`, e o `pageRetryRef` de `Publicar.js`) passou pela sentinela quando foi enviada.
- Se o modelo não carregou, falhou ou o texto passa de 128 tokens, a sentinela fica calada e a publicação segue. Falhar aberto aqui é o certo: a autoridade é consultiva e a recusa dura continua sendo de `wordCheck`.

**Na entrada.**

- Veredito por linha na interface, calculado só para linhas visíveis ou prestes a aparecer, depois do primeiro render.
- Cache local num par `sentinelStore.native.js` / `sentinelStore.web.js`, como os outros `*Store` de `apps/app/src`. O cache guarda só o veredito e a versão do modelo, nunca o texto, e some quando a versão muda. Mesmo sem texto, ele é um registro em repouso do que a pessoa leu, com as regras da seção 4 (k): tamanho limitado, validade curta, apagado ao sair e ao excluir a conta, só no aparelho, e chave por digest com sal em vez de `(autora, seq)` em claro.
- Ação padrão proposta: recolher a linha com "Conteúdo possivelmente sensível" e "ver mesmo assim"; para imagem, desfocar. A pessoa ajusta em Ajustes (seção 14, item 4).
- "Denunciar" de um toque abre a tela que já existe (`Denunciar.js`) com o motivo sugerido marcado (nunca `spam`, seção 4 c) e o trecho preenchido, e envia por `buildReportStart` e `buildReportSend` de `report.js`. Quem toca é a pessoa, e ela ainda confirma.
- Bloqueio pessoal tem prioridade: uma linha que `blockedRowView` já esconde nunca chega à sentinela.

**Superfícies propostas.**

| Superfície | Antes de publicar | Na entrada | Observação |
|---|---|---|---|
| Publicações, respostas, citações e momentos públicos | sim | sim | onde `wordCheck` já vale |
| Mensagens de grupo público (Comunidades) | sim | sim | idem |
| Feira: anúncios e avaliações | sim | sim | denúncia de anúncio usa `listingReportParams` |
| Perfis: nome, bio, @nome, de membro e de Página | sim | sim, só texto | avatar entra só se a v1 tiver imagem |
| Depoimentos | sim | sim, ao mostrar no perfil | o texto é cifrado até quem recebe mostrar |
| Mensagens diretas | não | não por padrão | decisão da manutenção (item 2) |
| Grupos privados | não | não por padrão | idem |
| Denúncias e recursos | não | não | precisam poder citar o termo, como em `wordCheck` |

**O que a sentinela nunca faz.**

- Nunca bloqueia uma chave, nunca impede uma publicação, nunca apaga nada.
- Nunca envia veredito, pontuação, texto ou contagem para fora do aparelho.
- Nunca denuncia sozinha, nem preenche e envia sem o toque e a confirmação da pessoa.
- Nunca põe marca "sentinela" na denúncia.
- Nunca roda no worklet do nó nem num processo com a chave.
- Nunca baixa pesos em execução sem decisão da manutenção (seção 9).
- Nunca lê o que está cifrado sem decisão explícita (mensagens diretas, grupos privados).

## 6. Categorias

`legal.js`:63 proíbe: "conteúdo ilegal; exploração ou sexualização de crianças e adolescentes; imagens íntimas de alguém sem o consentimento dessa pessoa; pornografia; ameaças, assédio ou intimidação; discurso de ódio; incentivo à violência ou à automutilação; e spam".

| Categoria dos Termos | Motivo em `REASONS` | Sentinela? |
|---|---|---|
| Spam | `spam` | sim, texto, só como aviso; na denúncia assistida, nunca pré-selecionado, porque é o único motivo que `triage.js` bloqueia sozinho (seção 4 c) |
| Ameaças, assédio, intimidação | `assedio` | sim, texto; ameaça explícita já está em `blockedTerms.js` |
| Discurso de ódio | `outro` (ou `assedio` quando dirigido a alguém) | sim, texto; é onde o viés da seção 4 (g) mais pesa |
| Pornografia | `outro` | imagem, se a v1 tiver imagem |
| Imagens íntimas sem consentimento | `ilegal` | não dá para inferir consentimento; no máximo o desfoque de nudez |
| Incentivo à violência | `outro` | texto, com cautela |
| Incentivo à automutilação | `outro` | mostrar ajuda (por exemplo o CVV, 188), não acusar nem sugerir denúncia a quem escreve sobre si |
| Conteúdo ilegal | `ilegal` | não: depende de contexto jurídico |
| Exploração ou sexualização de crianças e adolescentes | `ilegal` | não há classificador no aparelho; ver abaixo |

Fica fora da v1:

- **Abuso sexual infantil.** Nenhum classificador no aparelho. Montar ou testar com esse material é crime, e um classificador público ensinaria a contornar. A comparação com listas de hashes continua sendo trabalho do servidor (issue #79), que hoje não existe. Termos graves de texto já estão em `blockedTerms.js`.
- **Vídeo** além do quadro de capa: classificar todos os quadros custa bateria demais.
- **Texto dentro de imagem** (memes, capturas de tela): pediria OCR, outro modelo e outro custo.
- **Áudio.**

## 7. Candidatos

Tamanhos "q8" ou "INT4" são do arquivo publicado quando existe; quando só há o arquivo fp32, a estimativa é cerca de um quarto do fp32 e diz "estimativa". Parâmetros vêm da contagem que o Hugging Face mostra para o arquivo safetensors, salvo indicação.

### Texto

**T-a. MiniLM multilíngue já fixado mais uma cabeça pequena.**

- Modelo: `Xenova/paraphrase-multilingual-MiniLM-L12-v2`, na revisão já fixada no servidor (`2c4055b12046f11709e9df2c122e59ffbdc2f900`, a mesma que o Hugging Face mostra hoje como `sha` do repositório).
- Parâmetros: 117.654.272 (repositório de origem `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2`). Conta própria: as 250.037 linhas da tabela de embeddings (`vocab_size` do `config.json`; o tokenizador usa 250.002 peças) vezes 384 dimensões dão cerca de 96 milhões de parâmetros só na tabela de embeddings, cerca de 82% do modelo.
- Tamanho: `onnx/model_quantized.onnx` 118,3 MB (q8); `tokenizer.json` 17,1 MB.
- Licença: Apache-2.0 no repositório de origem; o repositório Xenova não declara licença no card (a conferir).
- pt-BR: o card de origem inclui `pt`; o servidor já mediu cosseno 0,86 entre duas paráfrases em português (`docs/design.md`).
- Tokenizador: SentencePiece do XLM-R, cerca de 250 mil peças.
- Runtime: ONNX Runtime, o mesmo arquivo que o servidor carrega. A cabeça seria uma regressão logística ou uma camada pequena sobre o vetor de 384 dimensões (alguns KB), treinada por categoria.
- A favor: zero modelo novo, paridade testável com o servidor (cosseno contra o vetor do servidor), um só arquivo nas duas pontas. Contra: 118 MB para um classificador; um embedding de paráfrase não foi treinado para toxicidade, então a cabeça herda o que o espaço não separa.

**T-b. BERTimbau ajustado em conjuntos pt-BR.**

- Base: `neuralmind/bert-base-portuguese-cased`, licença MIT; parâmetros da base, a conferir (o ajuste abaixo tem 108.931.338).
- `dougtrajano/toxicity-type-detection`: BERTimbau base ajustado no OLID-BR, multirrótulo (`health`, `ideology`, `insult`, `lgbtqphobia`, `other_lifestyle`, `physical_aspects`, `profanity_obscene`, `racism`, `sexism`, `xenophobia`), Apache-2.0, 108.931.338 parâmetros, `model.safetensors` 435,8 MB fp32 (q8, estimativa: cerca de 110 MB). Métricas no card: não publicadas (`results: []`).
- `ruanchaves/bert-base-portuguese-cased-hatebr`: ofensivo ou não, sem licença declarada no card, e o próprio card diz que o HateBR é "strictly for academic and research purposes", com uso comercial ou não acadêmico proibido sem consentimento da SINCH. Fica fora salvo parecer.
- Tokenizador: WordPiece de cerca de 30 mil peças (`vocab.txt` 0,2 MB), muito mais barato de portar que o SentencePiece do T-a.
- Runtime: ONNX Runtime depois de exportar para ONNX (exportação e quantização por conta própria).
- A favor: treinado em pt-BR de rede social. Contra: modelo novo, segundo arquivo grande, e os conjuntos de treino têm licenças restritivas (seção 8).

**T-c. Classificadores multilíngues de toxicidade.**

- `unitary/multilingual-toxic-xlm-roberta` (Detoxify): Apache-2.0, XLM-R, Jigsaw multilíngue, `portuguese` entre os 7 idiomas; parâmetros, a conferir. O card avisa que os modelos do Hugging Face dão resultados diferentes da biblioteca detoxify.
- `textdetox/bert-multilingual-toxicity-classifier`: openrail++, base `google-bert/bert-base-multilingual-cased`, 177.854.978 parâmetros; cobertura de português, a conferir.
- `textdetox/xlmr-large-toxicity-classifier`: openrail++, base `FacebookAI/xlm-roberta-large`; o Hugging Face mostra 278.045.186 parâmetros, número de um XLM-R base apesar do nome (a conferir). Grande demais para o aparelho de qualquer forma.
- `citizenlab/distilbert-base-multilingual-cased-toxicity`: DistilBERT multilíngue em Jigsaw, `pt` listado, sem licença declarada no card (a conferir).
- A favor: prontos. Contra: treinados sobretudo em comentários em inglês traduzidos ou da Wikipedia; viés conhecido contra termos de identidade; openrail++ traz restrições de uso que precisam ser lidas frente à PolyForm.

**T-d. MiniLM destilado próprio, com vocabulário podado para português.**

- Ideia: partir do T-a, cortar a tabela de 250 mil peças para as peças que aparecem em português (algumas dezenas de milhares) e destilar uma cabeça de classificação.
- Tamanho, estimativa: com 30 a 50 mil peças, 32 a 40 milhões de parâmetros, cerca de 30 a 40 MB em q8. A medir.
- Custo: trabalho de treino e avaliação próprio; perde a paridade exata com o vetor do servidor (o servidor teria de usar o mesmo modelo podado, ou a paridade deixa de ser uma prova).

**T-e. Embeddings estáticos (classe model2vec) mais cabeça linear em JavaScript puro.**

- `minishlab/potion-multilingual-128M`: MIT, 128.090.368 parâmetros, destilado do `BAAI/bge-m3` segundo o README do model2vec, `model.safetensors` 512,4 MB fp32, `tokenizer.json` 18,6 MB, `pt` nas etiquetas.
- O model2vec diz que a destilação não precisa de dados ("just a vocabulary and a model") e que a inferência depende só de numpy. Quantização e poda de vocabulário: o README não as menciona (a conferir na documentação). Implementação oficial em JavaScript: não mencionada (a conferir).
- A inferência é tokenizar, somar vetores e aplicar uma camada linear: cabe em JavaScript puro, sem runtime nativo, e rodaria também na web e no PWA. Uma destilação própria do T-a com vocabulário português podado e vetores de 256 dimensões em int8 ficaria em poucos MB a dezenas de MB (estimativa, a medir).
- A favor: sem código nativo, mesma lógica em todas as plataformas, carga quase instantânea. Contra: qualidade menor que um codificador com atenção, sobretudo em ironia e negação ("não sou racista, mas"), justamente os casos difíceis da seção 4 (g).

**T-f. LLMs geradores de guarda ("mini LLM").**

- `meta-llama/Llama-Guard-3-1B`: Llama 3.2 Community License, acesso fechado (aceite no Hugging Face). O Hugging Face mostra 1.498.482.688 parâmetros; o card diz que a versão podada tem 1123 milhões e que a poda da camada de saída economiza 131,3 MB com pesos de 4 bits. Tamanho total da versão INT4: a conferir. Português listado. Categorias S1 a S13 da taxonomia MLCommons (crimes violentos, crimes sexuais, exploração sexual infantil, ódio, suicídio e autolesão, conteúdo sexual e outras). F1/FPR em português no card: 0,763/0,114 (1B) e 0,830/0,109 (INT4). Uma taxa de falso positivo de cerca de 11% está muito acima do teto de 1 a 2% proposto na seção 8.
- `google/shieldgemma-2b`: licença Gemma, acesso fechado, só inglês segundo o card, quatro tipos de dano (sexual explícito, perigoso, ódio, assédio); o Hugging Face mostra 2.614.341.888 parâmetros.
- `google/gemma-3-270m` (268.098.176 parâmetros) e `google/gemma-3-1b-it` (999.885.952): licença Gemma, mais de 140 idiomas, contexto de 32 mil tokens. Não são modelos de guarda; precisariam de ajuste fino.
- `Qwen/Qwen2.5-0.5B-Instruct` (494.032.768 parâmetros) e `Qwen/Qwen3-0.6B` (751.632.384): Apache-2.0. Também precisariam de ajuste fino; cobertura de pt-BR, a conferir.
- No aparelho, os dois de guarda (Llama Guard 3 1B, inclusive a versão INT4 para celular que o card descreve, e ShieldGemma 2B) ficam entre centenas de MB e mais de 1 GB e custam mais latência e bateria que um codificador ou um NLI (a medir).
- Runtimes: llama.cpp (MIT) com a ligação React Native `llama.rn` (MIT; o npm mostra hoje `0.13.0-rc.11`, uma pré-versão), LiteRT-LM (Apache-2.0), ExecuTorch (licença BSD) com `react-native-executorch` (MIT).

**T-g. Modelos do sistema.**

- Apple Foundation Models: a documentação da Apple marca o framework a partir do iOS 26.0, e o modelo no aparelho depende de um aparelho com Apple Intelligence (lista de aparelhos e suporte a pt-BR, a conferir). O app aceita iOS 18.0 (`"deploymentTarget": "18.0"` em `app.json`), então uma parte dos aparelhos ficaria sem sentinela. Modelo no aparelho de cerca de 3 bilhões de parâmetros e geração guiada com saída tipada (a conferir na documentação atual).
- Gemini Nano: roda no serviço AICore do Android, acessado pelas ML Kit GenAI APIs, com termos de serviço adicionais. A página oficial não lista aparelhos; a cobertura é um subconjunto de aparelhos recentes (a conferir), bem menor que `minSdkVersion` 31.
- A favor: nenhum peso no app, nenhum download nosso. Contra: comportamento muda com atualização do sistema (sem revisão fixa), política de segurança do fornecedor no meio, cobertura desigual entre iPhone e Android e entre aparelhos caros e baratos, que é exatamente onde a moderação não pode ser desigual. A saída é gerada, não uma probabilidade calibrada.

**T-h. NLI zero-shot ("Jev leve" no aparelho).**

- Como funciona: a publicação é a premissa e cada categoria dos Termos tem uma hipótese fixa em pt-BR (ofensa ou assédio, conteúdo sexual explícito, ameaça ou violência, discurso de ódio, spam). A avaliação não tem hipótese de controle neutro: um post limpo conta como acerto quando nenhuma categoria passa do corte. A pontuação da categoria é o softmax entre `entailment` e `contradiction`, a receita usual de zero-shot. Sem treino: um sim ou não tipado por categoria, parecido com a pergunta "Noul" do Jev.
- `MoritzLaurer/multilingual-MiniLMv2-L6-mnli-xnli`, revisão `0a71e92a985b6e1ad1828cf67ce9c459639c1dca`, MIT. Publica só `onnx/model.onnx` fp32, 428.127.016 bytes, a maior parte na tabela de cerca de 250 mil peças. Quantizado localmente para o spike só na camada de embedding: int8 dinâmico com o onnxruntime 1.32.0 em Python, `quantize_dynamic(..., weight_type=QInt8, op_types_to_quantize=['Gather'])`, sobre o fp32. Resultado: 139.580.898 bytes, sha256 `c15eef0c5b1e987b3190259c2a5c81f9bca023c508002881ade33af3706675c9`.
- `MoritzLaurer/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7`, revisão `b5113eb38ab63efdd7f280f8c144ea8b13f978ce`, MIT. O `onnx/model_quantized.onnx` publicado (q8, 338.679.133 bytes) não serve no onnxruntime-node 1.21 (seção 14, decisão 25), então o spike aplica a ele a mesma quantização só de Gather: 538.123.257 bytes, sha256 `9d433ee4019854e340020c20e62903d92d76d9ec25f8fc8d6a7ad4a0f6832bd6`. É a referência mais forte e mais pesada, e roda só no Node: com 538 MB, fica fora do orçamento do aparelho e do bench de celular.
- Plataforma: ONNX Runtime nativo, o mesmo módulo do spike (seção 12), com par codificado de até 256 tokens e ids de token abaixo de 250.002 (o vocabulário do MiniLM). O tokenizador fica fora do spike, como no spike 1.
- Custo: uma passada por par (publicação, hipótese), então N categorias custam N passadas por texto. Calibração das pontuações e qualidade em gíria pt-BR: desconhecidas até a seção 8.
- A favor: começa sem conjunto rotulado e sem treino; mudar uma categoria é mudar uma frase. Contra: N passadas por texto, arquivos grandes (o MiniLM int8 tem 140 MB e o mDeBERTa int8 passa de 500 MB) e nenhuma paridade com o servidor, que não roda NLI.

**T-i. Jev (TypeSafe), só no servidor.**

- Hospedado: um endpoint, `POST /v1/systemone` em `api.typesafe.ai`, com chave de API. Modelos `jev-1.14.0` e `jev-1.13.0`. Entrada de texto e de imagem PNG ou JPEG. Tipos de pergunta: Choice, Score, Noul e Box (Box só na 1.14).
- Preço: USD 0,042 por milhão de tokens de entrada; a saída não é cobrada. Os mesmos pesos para todas as contas, e a documentação diz que os pedidos dos clientes não treinam o modelo. Retenção zero de dados só no plano enterprise.
- Pesos para baixar, auto-hospedagem e runtime de celular: nenhum documentado. Não roda no aparelho. Tamanho e parâmetros: não publicados. Licença: os termos de serviço da TypeSafe (a conferir).
- Uso possível: só no servidor, só em conteúdo público, com contrato de tratamento de dados e retenção zero, e só com decisão da manutenção sob a seção 10. Nunca mensagens diretas nem grupos privados. Também poderia ajudar a rotular um conjunto pt-BR sintético ou público para a seção 8.
- Contra: o texto sai para um terceiro, o que muda a postura de "nada sai do aparelho" e acrescenta um operador de dados. Não é uma sentinela no aparelho: é outro caminho de triagem no servidor.

**Resumo das opções do spike 2.**

| Opção | Tamanho | Licença | Onde roda | Fonte |
|---|---|---|---|---|
| T-i Jev | não publicado (hospedado) | termos da TypeSafe, a conferir | só servidor, por API | docs.typesafe.ai/models.md |
| T-h MiniLMv2-L6 NLI | fp32 428,1 MB; int8 (só Gather) 139,6 MB | MIT | aparelho (ONNX Runtime) | Hugging Face, revisão fixada, mais o sha256 do int8 |
| T-h mDeBERTa-v3 NLI | q8 publicado 338,7 MB; int8 (só Gather) 538,1 MB | MIT | no spike, só Node: grande demais para o aparelho | Hugging Face, revisão fixada, mais o sha256 do int8 |
| T-g Apple Foundation Models | no sistema (cerca de 3B parâmetros, a conferir) | termos da Apple, a conferir | iOS 26 com Apple Intelligence | documentação da Apple |
| T-g Gemini Nano | no sistema | termos adicionais das ML Kit GenAI APIs | Android com AICore, aparelhos recentes (a conferir) | documentação do Android |
| T-f Llama Guard 3 1B | INT4 a conferir (estimativa: centenas de MB) | Llama 3.2 Community License | aparelho (llama.cpp, ExecuTorch) | Hugging Face |
| T-f ShieldGemma 2B | mais de 1 GB (estimativa, pelos 2,6 bilhões de parâmetros) | licença Gemma | aparelho, com RAM alta | Hugging Face |

**Codificador classificador contra "mini LLM" gerador.** Um codificador (T-a a T-d) lê o texto uma vez e devolve uma pontuação por categoria: dezenas a pouco mais de cem MB, RAM da ordem do arquivo, e uma passada por publicação (no servidor, o MiniLM roda com prazo de 10 s por texto; no aparelho, a medir). Um gerador de guarda de 0,3 a 1,5 bilhão de parâmetros, mesmo em INT4, pesa centenas de MB a cerca de 1 GB, precisa de RAM do mesmo tamanho mais o cache de atenção, e gera tokens: a resposta "seguro / inseguro S10" custa uma passada de leitura do texto inteiro mais alguns tokens de saída, provavelmente uma ordem de grandeza mais lenta por publicação (a medir). O ganho do gerador é a taxonomia pronta e a política em linguagem natural; a perda é tamanho, RAM, latência, download, e uma FPR publicada em português que não serve para avisar ninguém. Para a v1 a recomendação é um codificador; o gerador só faz sentido no aviso antes de publicar (uma chamada por publicação, não uma por linha), e mesmo assim só com piso de RAM e download opcional. O NLI zero-shot (T-h) fica no meio: é um codificador, com saída por categoria, mas paga uma passada por categoria, e os arquivos testados vão de 140 MB (o MiniLM int8) a 538 MB (o mDeBERTa int8).

### Imagem

**I-a. Apple SensitiveContentAnalysis.** iOS e iPadOS 17.0 ou mais novo, macOS 14.0. Exige o entitlement `com.apple.developer.sensitivecontentanalysis.client` ("fails to return positive results for apps that lack this entitlement"), e só age quando a pessoa ligou o ajuste Sensitive Content Warning ou o Communication Safety do Tempo de Uso. A documentação fala em nudez ("detect nudity in images and video"). Só iOS; nomes das classes da API, a conferir. A favor: nada a embarcar, a escolha é da pessoa no sistema. Contra: só nudez, só iOS, desligado por padrão.

**I-b. GantMan `nsfw_model`, MobileNetV2.** Licença MIT, com a ressalva do LICENSE.md de que há material de terceiros sob outras licenças. Entrada 224x224, cinco classes (`drawings`, `hentai`, `neutral`, `porn`, `sexy`). O README cita 93% de acurácia para a variante Inception v3, não para a MobileNetV2. Formatos: Keras, TensorFlow.js, TensorFlow `.pb`; sem ONNX nem TFLite (conversão por conta própria). Tamanho, a conferir.

**I-c. Marqo `nsfw-image-detection-384`.** Apache-2.0. `config.json`: `vit_tiny_patch16_384`, duas classes (`NSFW`, `SFW`), entrada 384x384. 5.597.762 parâmetros, `model.safetensors` 22,4 MB. Biblioteca timm (exportação para ONNX por conta própria). Métricas: não estão no card (a conferir).

**I-d. Falconsai `nsfw_image_detection`.** Apache-2.0. `config.json`: ViT de 12 camadas, `hidden_size` 768, `image_size` 224 (um ViT base). 85.800.194 parâmetros, `model.safetensors` 343,2 MB. Métricas: não encontradas no card (a conferir).

**I-e. OpenNSFW2.** Código MIT; licença dos pesos não declarada no README (o modelo original do Yahoo, a conferir). Implementação Keras 3 do Open-NSFW, entrada 224x224, saída de uma probabilidade. Tamanho e arquitetura, a conferir.

**I-f. Bumble `private-detector`.** Apache-2.0. Baseado em EfficientNet-v2 (variante, a conferir), SavedModel do TensorFlow, detecta imagens obscenas; sem métricas no README (há um whitepaper, a conferir).

**NudeNet.** O GitHub classifica o repositório como AGPL-3.0. Licença dos pesos, a conferir. Fica fora até um parecer: AGPL num app distribuído sob PolyForm é um conflito provável.

### Runtimes

| Opção | O que é | A favor | Contra |
|---|---|---|---|
| ONNX Runtime nativo num módulo local | pods `onnxruntime-c` ou `onnxruntime-objc`, Maven `com.microsoft.onnxruntime:onnxruntime-android`, licença MIT | o mesmo arquivo ONNX do servidor (paridade), uma API nas duas plataformas, controle de threads | binário grande; o pacote pronto traz todos os operadores e reduzir pede build próprio |
| Core ML no iOS e LiteRT no Android | conversões separadas | aceleradores do sistema, binário pequeno no iOS | dois arquivos, duas conversões, paridade entre plataformas e com o servidor deixa de ser automática |
| `onnxruntime-react-native` | pacote npm da Microsoft (hoje `1.24.3`, MIT) | pronto | mais uma camada JSI chamada do JavaScript, versão acoplada ao React Native, dependência nova no `package.json` |
| `llama.rn` (llama.cpp) | para T-f | roda GGUF quantizado | só para geradores; pré-versão; RAM |

Recomendação para o spike: ONNX Runtime nativo num módulo local, porque é o único caminho em que o mesmo arquivo e a mesma revisão rodam no servidor e no aparelho.

## 8. Avaliação em pt-BR

**Conjuntos públicos.** Baixados pelo operador para um diretório fora do repositório e nunca versionados, como os pesos de `fetch-ai-model.js`.

| Conjunto | Licença conferida | Observação |
|---|---|---|
| ToLD-Br | CC BY-SA 4.0 (LICENSE do repositório e card do Hugging Face) | tóxico multirrótulo, tweets |
| HateBR | CC BY-NC 4.0 no LICENSE do repositório; o card do ajuste `ruanchaves` diz "strictly for academic and research purposes" | uso pela associação, a conferir com parecer |
| OLID-BR | Apache-2.0 no repositório do GitHub, CC BY 4.0 no card do Hugging Face | as duas licenças divergem; a conferir |
| TuPy-E | MIT no repositório do GitHub, CC BY 4.0 no card do Hugging Face | idem |
| OffComBR | sem licença declarada no repositório | só com autorização, a conferir |

**Conjunto benigno sintético.** 300 a 500 textos escritos pelo mantenedor (ou por quem ele designar), sem nenhum conteúdo de membro: conversa de bairro, Feira, futebol e rivalidade, saúde e corpo, notícia de violência, termos reapropriados ditos pelo próprio grupo, denúncia ou relato que cita o termo para condená-lo, frases neutras com termos de identidade, gírias regionais de várias partes do país. É o conjunto que decide se a sentinela pode avisar alguém.

**Métricas.**

- Precisão a uma FPR fixa no conjunto benigno: propor no máximo 1 a 2%. Abaixo disso a sentinela não sai.
- Recall por categoria, PR-AUC, calibração (diagrama de confiabilidade).
- Diferença entre q8 e fp32 nas mesmas métricas.
- Fatias de ofuscação: leet ("v4g4bund0"), espaçamento ("v a g a"), sem acento, emoji no lugar de letras.
- FPR por termo de identidade, em frases neutras.
- Textos com menos de 8 caracteres e com mais de 128 tokens (o servidor não decide nos dois casos; a sentinela deveria ficar calada também).

**Spike 2 (NLI).**

- A acurácia se mede no Node, com os mesmos pesos que vão ao aparelho, pelo script só de desenvolvimento `apps/cli/scripts/sentinel-nli-eval.js`. A CI não o roda, e ele precisa dos modelos locais.
- Conjunto: `apps/cli/scripts/sentinel-nli-eval-set.json`, 86 publicações sintéticas curtas em pt-BR: 43 com rótulo de categoria e 43 limpas, 19 destas difíceis de propósito (`p068` a `p086`, limpas mas perto de uma categoria). Os exemplos ofensivos são brandos, sem insulto discriminatório e sem pessoas reais. Isso enfraquece a avaliação: o conjunto não traz a gíria, a ironia nem os casos difíceis da seção 4 (g), e não substitui o conjunto benigno acima.
- Métricas: AUC por categoria e precisão e recall nos cortes 0,5, 0,7 e 0,9, para os dois modelos e dois jogos de hipóteses (o canônico, na tabela, e um alternativo), mais os falsos positivos nas 19 limpas difíceis e a latência no Node.
- O aparelho não mede acurácia: confere a paridade dos logits contra `apps/app/src/sentinel/nliFixture.json` (maior diferença absoluta até 1e-3 e o mesmo argmax) e mede carga, latência e memória (seção 12).

| Modelo | Categoria | Positivos | AUC | P / R a 0,5 | P / R a 0,7 | P / R a 0,9 |
|---|---|---|---|---|---|---|
| MiniLMv2-L6 int8 | ofensa ou assédio | 13 | 0,90 | 0,22 / 1,00 | 0,33 / 1,00 | 0,44 / 0,62 |
| MiniLMv2-L6 int8 | conteúdo sexual explícito | 8 | 0,42 | 0,09 / 1,00 | 0,09 / 0,88 | 0,07 / 0,25 |
| MiniLMv2-L6 int8 | ameaça ou violência | 9 | 0,68 | 0,10 / 1,00 | 0,11 / 1,00 | 0,17 / 0,67 |
| MiniLMv2-L6 int8 | discurso de ódio | 8 | 0,60 | 0,10 / 0,38 | 0,08 / 0,25 | 0,25 / 0,13 |
| MiniLMv2-L6 int8 | spam | 9 | 0,33 | 0,00 / 0,00 | 0,00 / 0,00 | sem positivo previsto / 0,00 |
| mDeBERTa-v3 int8 | ofensa ou assédio | 13 | 0,76 | 0,21 / 0,92 | 0,23 / 0,92 | 0,27 / 0,92 |
| mDeBERTa-v3 int8 | conteúdo sexual explícito | 8 | 0,51 | 0,08 / 0,75 | 0,08 / 0,63 | 0,10 / 0,63 |
| mDeBERTa-v3 int8 | ameaça ou violência | 9 | 0,94 | 0,21 / 1,00 | 0,24 / 1,00 | 0,28 / 0,89 |
| mDeBERTa-v3 int8 | discurso de ódio | 8 | 0,89 | 0,15 / 1,00 | 0,17 / 1,00 | 0,21 / 0,88 |
| mDeBERTa-v3 int8 | spam | 9 | 0,11 | 0,02 / 0,11 | 0,00 / 0,00 | 0,00 / 0,00 |

Latência no Node por par, tokenização mais inferência, 860 pares (p50 / p95, ms): MiniLMv2-L6 int8 2,5 / 3,6; mDeBERTa-v3 int8 23,4 / 46,4. Node v24.22.1, Apple M4 Pro, onnxruntime-node 1.21 no CPU, threads padrão. Sensível à carga da máquina: uma repetição com o Mac ocupado deu 5,0 / 15,3 e 46,5 / 150,2, com as mesmas tabelas de acerto.

**Leitura.**

- Falsos positivos nas 19 limpas difíceis, em qualquer categoria: MiniLM 19, 19 e 14 nos cortes 0,5, 0,7 e 0,9; mDeBERTa 18, 16 e 13. A maior pontuação por publicação limpa tem mediana 0,91 no MiniLM e 0,93 no mDeBERTa: os dois saturam, e nenhum corte fixo separa limpo de rotulado.
- O MiniLM só ajuda em ofensa (AUC 0,90). O mDeBERTa ordena bem violência e ódio (0,94 e 0,89), mas com precisão de 0,28 e 0,21 no corte 0,9. Os dois falham em conteúdo sexual (0,42 e 0,51) e em spam (0,33 e 0,11, pior que o acaso).
- A frase da hipótese pesa muito: com o jogo alternativo, a AUC de ofensa do MiniLM cai de 0,90 para 0,59, e a de ódio do mDeBERTa sobe de 0,89 para 0,92; sexual e spam continuam em 0,54 ou menos nos dois modelos.
- Conclusão do spike 2: NLI zero-shot com hipóteses fixas não serve sozinho como sentinela. O melhor uso é um sinal auxiliar ao lado do embedding com cabeça treinada (T-a), e mesmo isso só depois do conjunto benigno acima. O conjunto é pequeno (8 a 13 positivos por categoria) e brando, então estas AUCs têm margem de erro larga.

**Imagens.** Usar as métricas publicadas (quando existem) e um conjunto benigno licenciado: praia, amamentação, arte com nudez, imagem médica, academia. Nunca montar, baixar ou guardar material ilegal para teste, nem "para avaliar recall".

## 9. Entrega dos pesos

| Opção | Efeito |
|---|---|
| Embutidos no app | o APK e o `.app` crescem o tamanho do modelo mais o runtime; tudo fixado no build; nenhum download |
| Pacotes de recursos das lojas (Play Asset Delivery; no iOS, recursos baixados pela loja, a conferir qual API) | o app base não cresce; o download vem da loja, com a revisão do build |
| Download fixado do servidor da associação, com sha256 | o app não cresce; muda a postura de hoje, em que "Em execução nada é baixado" (`docs/design.md`, triagem); o pedido revela à associação quem ligou a sentinela |

Orçamento proposto: até cerca de 25 MB a mais no download para uma sentinela ligada por padrão (o que exclui T-a, T-b e T-c embutidos sem poda), até cerca de 150 MB para uma opcional baixada sob demanda. São números para a manutenção discutir, não medidos.

## 10. Privacidade e LGPD

- Nada sai do aparelho: nem veredito, nem pontuação, nem contagem. A associação não trata dado novo por causa da sentinela. A denúncia de um toque é a denúncia de hoje.
- **Jev ou outro serviço hospedado (seção 7, T-i)** quebraria a primeira regra desta seção: o texto da publicação iria para um terceiro. Só seria aceitável no servidor, só para conteúdo público, com contrato de tratamento de dados, retenção zero (na TypeSafe, só no plano enterprise), registro na Política de Privacidade e decisão da manutenção (seção 14, item 22). Mensagens diretas e grupos privados nunca.
- **Art. 20 da LGPD** (revisão de decisões tomadas unicamente com base em tratamento automatizado): `docs/design.md` já pergunta se a recusa de `wordCheck` conta como decisão automatizada. A sentinela é mais branda (aviso, sem recusa), mas é inferência sobre o conteúdo da pessoa, e o desfoque na entrada é inferência sobre conteúdo de terceiros. A mesma pergunta vai ao parecer jurídico.
- Quando for entregue: uma versão nova dos Termos e da Política de Privacidade descrevendo a sentinela, as superfícies e o que nunca sai do aparelho, com novo aceite, como o projeto já faz.
- O cache local de vereditos (seção 4 k) não sai do aparelho, mas é dado pessoal guardado no aparelho sobre o que a pessoa leu: a Política deve dizer que existe, quanto dura e quando some (ao sair e ao excluir a conta).
- Estado pretendido para uma versão de produto futura: o manifesto de privacidade de `app.json` (`NSPrivacyCollectedDataTypes`) sem mudança, porque nada é coletado. Se a entrega dos pesos for por download da associação, revisar. O spike não muda o manifesto.

## 11. Desempenho

- Metas de `docs/performance.md` ("Metas provisórias") continuam valendo: em especial a vitrine nativa com primeiro commit da lista em até 300 ms e p95 de quadro em até 32 ms na rolagem.
- Carregamento preguiçoso: o modelo só carrega depois do primeiro render da tela que o usa, nunca no caminho de partida do app nem do worklet.
- Descarregar quando o app vai para segundo plano e depois de um tempo sem uso; medir quanto a memória volta (seção 12).
- Inferência fora da thread de interface, com no máximo 2 threads por padrão (a medir), e por lote pequeno de linhas visíveis.
- Partida a frio com a flag desligada não pode piorar nada: essa é a primeira medição a fazer em aparelho real, comparando com um build sem o módulo (seção 12).

## 12. Medições do spike

**Método.**

- Módulo nativo `apps/app/modules/sentinel-spike` com ONNX Runtime nativo (pod no iOS, Maven no Android), carregando o `model_quantized.onnx` da revisão fixada.
- Disparo: o executor `apps/app/src/sentinel/runBench.native.js` (com um irmão `runBench.web.js` vazio), chamado por um gancho em `apps/app/index.js` só quando `__DEV__ && process.env.EXPO_PUBLIC_VARANDA_SENTINEL_BENCH === '1'`. Sem a flag, ou num build de release, nada carrega (conferido: os bundles de `expo export` sem a flag não contêm `sentinel-bench`). O código nativo tem uma segunda trava: no iOS, `#if DEBUG`; no Android, o `FLAG_DEBUGGABLE` do app hospedeiro. Fora de um build de debug, `isAvailable` responde falso e toda chamada falha com `UNSUPPORTED`.
- Entradas: ids de token prontos num fixture `apps/app/src/sentinel/benchFixture.json`, com três casos, `t16`, `t64` e `t128`, de 15, 66 e 127 tokens (os alvos aproximados de 16, 64 e 128 da medição), gerado por `apps/cli/scripts/sentinel-fixture.js` com o tokenizador do servidor, junto com os vetores que o servidor calcula, para comparar por cosseno.
- O modelo é copiado à mão para o sandbox do app; nada é baixado pelo app.
- Simulador e emulador provam carga e paridade, não latência: a CPU é a do Mac. Latência e memória só valem em aparelho real.
- **O tokenizador não está no spike.** Os ids vêm do fixture. Portar o SentencePiece do XLM-R para o aparelho (cerca de 250 mil peças, `tokenizer.json` de 17,1 MB, normalização idêntica à do servidor) é custo de produção, com teste de paridade próprio.

**Tabela A, carga e paridade.**

| Plataforma | Carga (ms) | Cosseno mínimo contra o servidor | Bytes do modelo | Runtime por ABI (bytes) |
|---|---|---|---|---|
| iOS simulador | 195 (1ª carga), 132 a 134 (seguintes) | 1,00 nos três casos e nas três contagens de threads | 118.308.126 | a medir: o `onnxruntime-c` entra estático no binário, então o tamanho sai de um build de release com e sem o módulo |
| Android emulador | 4.122 (1ª carga), 1.190 a 1.227 (seguintes) | 1,00 nos três casos e nas três contagens de threads | 118.308.126 | arm64-v8a 17.908.496 (6.971.855 comprimidos), x86_64 21.420.512 (8.441.618 comprimidos), mais cerca de 75 mil do JNI por ABI |
| iPhone real | a medir | a medir | a medir | a medir |
| Android real, até 4 GB | a medir | a medir | a medir | a medir |

**Tabela B, inferência (ms, p50 / p95), com os tamanhos reais dos casos do fixture.**

| Plataforma | Threads | n = 15 tokens | n = 66 tokens | n = 127 tokens |
|---|---|---|---|---|
| iOS simulador | 1 | 3,2 / 3,4 | 11,5 / 11,7 | 23,6 / 24,0 |
| iOS simulador | 2 | 2,6 / 4,6 | 7,0 / 9,1 | 13,4 / 14,2 |
| iOS simulador | 4 | 2,1 / 3,8 | 5,1 / 9,2 | 9,2 / 14,8 |
| Android emulador | 1 | 19,5 / 25,8 | 69,5 / 84,1 | 143,9 / 166,4 |
| Android emulador | 2 | 14,1 / 18,8 | 46,7 / 58,7 | 83,5 / 133,6 |
| Android emulador | 4 | 13,0 / 24,8 | 42,8 / 123,9 | 90,7 / 163,2 |
| iPhone real | 1 | a medir | a medir | a medir |
| iPhone real | 2 | a medir | a medir | a medir |
| iPhone real | 4 | a medir | a medir | a medir |
| Android real, até 4 GB | 1 | a medir | a medir | a medir |
| Android real, até 4 GB | 2 | a medir | a medir | a medir |
| Android real, até 4 GB | 4 | a medir | a medir | a medir |

**Tabela C, memória (MB).**

| Plataforma | Base | Após carga | Após execução | Após descarga |
|---|---|---|---|---|
| iOS simulador | 254 | 405 | 414 | 271 |
| Android emulador | 428 | 620 | 616 | 474 |
| iPhone real | a medir | a medir | a medir | a medir |
| Android real, até 4 GB | a medir | a medir | a medir | a medir |

**Tabela D, tamanho e interface.**

| Plataforma | Delta do APK ou do `.app` | Partida a frio com a flag desligada | p95 de quadro com inferência em laço |
|---|---|---|---|
| iOS simulador | a medir | a medir | a medir |
| Android emulador | cerca de 15,5 MB comprimidos (as entradas `libonnxruntime*.so` das duas ABIs no APK de debug, não uma comparação com e sem o módulo) | a medir | a medir |
| iPhone real | a medir | a medir | a medir |
| Android real, até 4 GB | a medir | a medir | a medir |

**Como estes números foram tirados (15 de novembro de 2026).** Build de debug com `EXPO_PUBLIC_VARANDA_SENTINEL_BENCH=1`, modelo copiado à mão para o sandbox (sha256 conferido). iOS: simulador iPhone 16e, iOS 26.2, num Mac M4 Pro. Android: emulador `sdk_gphone64_arm64`, Android 16, no mesmo Mac, com outros emuladores ligados ao mesmo tempo. Na Tabela A, a primeira carga é a da contagem de 1 thread e as seguintes são as de 2 e 4. Na Tabela B, cada célula sai de 50 inferências medidas depois de 5 de aquecimento, com o tempo nativo da inferência (no p50, o tempo de ida e volta pelo JS soma de 1 a 8 ms; no p95 a diferença chega a cerca de 34 ms no emulador). O laço de 60 s com 1 thread no caso de 66 tokens fez 3.567 inferências no simulador (p50 11,7 ms, p95 12,6 ms) e 525 no emulador (p50 60,7 ms, p95 84,1 ms). O cosseno sai arredondado a duas casas: 1,00 quer dizer pelo menos 0,995, acima do corte de 0,99. A Tabela C é a memória do processo inteiro, em MB (10^6 bytes), na rodada de 1 thread: carregar o modelo soma cerca de 150 MB no simulador e 190 MB no emulador, e descarregar devolve quase tudo (sobram cerca de 17 e 45 MB). Nos dois casos a CPU é a do Mac, então estes números provam carga, paridade e liberação de memória, não a latência num celular. As bibliotecas do ONNX Runtime 1.21.1 no APK têm todos os segmentos `LOAD` alinhados a 2^14 (16 KB), conferido com `llvm-objdump -p`, e `zipalign -c -P 16` passa. O tamanho no iOS, o delta do `.app` e a partida a frio pedem um build com e sem o módulo, e não foram feitos neste spike. Partida a frio, p95 de quadro e todas as linhas de aparelho real ficam "a medir": pedem um celular, assinatura e rolagem manual com `EXPO_PUBLIC_VARANDA_PERF=1`.

### Spike 2, NLI

**Método.** O mesmo módulo, com uma lista fixa no código nativo: `embed` carrega `sentinel/model_quantized.onnx` e `nli` carrega `sentinel/nli_quantized.onnx`. O caminho nunca vem do JS, e o sha256 é conferido antes da carga. A chamada `classify` devolve os logits crus (`logits`, forma [1, k] com k de 2 a 8; os dois modelos NLI dão k = 3) para um par codificado de até 256 tokens; `embed` recusa um modelo NLI e `classify` recusa o embedder. As entradas são os ids de token de 6 pares neutros fixos em `apps/app/src/sentinel/nliFixture.json`, gerado por `apps/cli/scripts/sentinel-nli-fixture.js`, com os logits de referência do Node. A fase NLI roda depois da de embedding e só se os dois modelos estiverem no sandbox (sem o embedder, o bench para antes); a fase de embedding não muda. Os números abaixo vêm de um build feito antes de três ajustes no módulo (o teto de ids de 251.000 para 250.002 e os códigos `MISSING`/`UNSUPPORTED`), que não tocam a inferência; os ids da fixture ficam abaixo de 236.000. Os mesmos limites do spike 1 valem: simulador e emulador provam carga e paridade, não latência de celular. Desvio do plano: só o MiniLM roda no aparelho. O mDeBERTa int8 (538 MB) passa do orçamento do aparelho e fica só na avaliação no Node (seção 8); as linhas dele abaixo dizem "não medido".

**Tabela E, carga, memória e paridade.**

| Plataforma | Modelo | Carga (ms) | Memória após carga (MB) | Maior diferença absoluta dos logits | Argmax igual nos 6 pares |
|---|---|---|---|---|---|
| iOS simulador | MiniLMv2-L6 int8 | 168 (1ª carga), 115 a 120 (seguintes) | 441 (antes da carga, 260; após descarga, 273) | até 1e-3 | sim, nas três contagens de threads |
| iOS simulador | mDeBERTa-v3 int8 | não medido | não medido | não medido | não medido |
| Android emulador | MiniLMv2-L6 int8 | 6.409 (1ª carga, cache frio), 559 a 851 (seguintes) | 647 (antes da carga, 477; após descarga, 473) | até 1e-3 | sim, nas três contagens de threads |
| Android emulador | mDeBERTa-v3 int8 | não medido | não medido | não medido | não medido |
| iPhone real | MiniLMv2-L6 int8 | a medir | a medir | a medir | a medir |
| iPhone real | mDeBERTa-v3 int8 | não medido | não medido | não medido | não medido |
| Android real, até 4 GB | MiniLMv2-L6 int8 | a medir | a medir | a medir | a medir |
| Android real, até 4 GB | mDeBERTa-v3 int8 | não medido | não medido | não medido | não medido |

**Tabela F, inferência por par (ms, p50 / p95), nos 6 pares do fixture.** Cada célula é o maior p50 e o maior p95 dos dois pares daquele tamanho.

| Plataforma | Modelo | Threads | 23 a 24 tokens | 75 a 77 tokens | 135 a 139 tokens |
|---|---|---|---|---|---|
| iOS simulador | MiniLMv2-L6 int8 | 1 | 5,9 / 6,1 | 17,5 / 17,8 | 32,3 / 32,5 |
| iOS simulador | MiniLMv2-L6 int8 | 2 | 3,4 / 3,5 | 9,4 / 9,8 | 17,0 / 18,0 |
| iOS simulador | MiniLMv2-L6 int8 | 4 | 2,0 / 2,7 | 5,5 / 6,3 | 9,5 / 10,2 |
| Android emulador | MiniLMv2-L6 int8 | 1 | 60,1 / 456,5 | 103,9 / 131,7 | 194,2 / 228,0 |
| Android emulador | MiniLMv2-L6 int8 | 2 | 24,3 / 34,1 | 64,5 / 89,4 | 129,5 / 166,2 |
| Android emulador | MiniLMv2-L6 int8 | 4 | 23,2 / 41,5 | 70,2 / 187,2 | 135,0 / 263,1 |
| iOS simulador, Android emulador | mDeBERTa-v3 int8 | 1, 2, 4 | não medido | não medido | não medido |
| iPhone real | MiniLMv2-L6 int8 | 1, 2, 4 | a medir | a medir | a medir |
| Android real, até 4 GB | MiniLMv2-L6 int8 | 1, 2, 4 | a medir | a medir | a medir |
| iPhone real, Android real | mDeBERTa-v3 int8 | 1, 2, 4 | não medido | não medido | não medido |

**Como estes números foram tirados (15 de novembro de 2026).** Os mesmos aparelhos virtuais e o mesmo Mac do spike 1 (simulador iPhone 16e com iOS 26.2; emulador `sdk_gphone64_arm64` com Android 16), num build de debug com o `nli_quantized.onnx` de 139.580.898 bytes copiado à mão (sha256 conferido pelo módulo). Cada par: 30 inferências medidas depois de 3 de aquecimento, com o tempo nativo da inferência (no p50, a ida e volta pelo JS soma menos de 1 ms no simulador e de cerca de 1,5 a 7 ms no emulador, com um par fora da curva em 25 ms). A carga é a de 1, 2 e 4 threads, nessa ordem; a fase NLI roda depois da de embedding, então a memória "antes da carga" é a da última descarga do embedder (`memory-unload-t4`), lida antes do laço de 60 s de embedding. Carregar o MiniLM NLI soma cerca de 181 MB no simulador e 170 MB no emulador, e descarregar devolve quase tudo. A paridade é contra os logits do Node: diferença absoluta de até 1e-3 nos 6 pares (`pass=1`, calculado sem arredondar; o valor impresso, `max_abs=0`, arredonda para duas casas e só diz que fica abaixo de 0,005), nas três contagens de threads, nas duas plataformas (o corte era 1e-3). O emulador é ruidoso: os p95 de 1 thread nos pares curtos (cerca de 450 ms) e a primeira carga de 6,4 s, com o cache frio, não dizem nada sobre um celular. Linhas de aparelho real ficam "a medir".

**Limites do spike 2.**

- Os scripts fixam por sha256 os quatro arquivos de cada modelo: o modelo, `tokenizer.json`, `config.json` (que traz a ordem dos rótulos `entailment` e `contradiction`) e `tokenizer_config.json`. No aparelho, o módulo confere só o modelo; o resto do lado do aparelho é a fixture de ids, gerada no computador.
- Há uma janela entre a conferência do sha256 no código nativo e a leitura do arquivo pelo ONNX Runtime (TOCTOU): o arquivo pode mudar entre as duas. No spike é aceitável (só debug, arquivo no sandbox do app, copiado à mão). Em produção a janela precisa fechar, por exemplo lendo os bytes para a memória, conferindo o hash desses bytes e criando a sessão a partir deles.

## 13. Proposta de texto para as regras

Nenhum destes arquivos é editado por este documento. É o texto que a manutenção pode adotar se decidir mudar a regra.

Proposta para o item de triagem em `AGENTS.md` ("Triagem de denúncias com IA"). Só a frase abaixo muda; o resto do item fica exatamente como está, palavra por palavra (o modo `VARANDA_AI`, as constantes de `ai/triage.js`, os tetos diários, a lista "sempre humano", `mod apply --yes`, os logs, o embedder falso, `VARANDA_TRIAGE_TOKEN` e o formato do `pull`).

Hoje:

> Não leve inferência para o aparelho nem para o processo que guarda a chave do emissor: o modelo roda num processo filho com ambiente vazio, e `npm ci --ignore-scripts` não pode deixar de valer.

Proposta:

> Não leve inferência para o processo que guarda a chave do emissor: o modelo do servidor roda num processo filho com ambiente vazio, e `npm ci --ignore-scripts` não pode deixar de valer. No aparelho, só a sentinela consultiva de `docs/sentinela.md`, num módulo nativo chamado pela interface, nunca no worklet Bare do nó e nunca por um método RPC; o veredito dela só avisa ou desfoca na tela, nunca bloqueia uma chave nem impede uma publicação, nunca sai do aparelho e não pesa no servidor, e uma denúncia sugerida por ela é uma denúncia comum, enviada pelo toque da pessoa e sem marca.

A primeira frase da proposta mantém a regra da chave do emissor sozinha; a segunda é nova e trata só do aparelho.

Proposta de adendo a `docs/design.md`, depois do parágrafo da triagem automática:

> **Sentinela no aparelho.** O app oficial pode rodar um modelo pequeno que avisa antes de publicar e desfoca, na tela de quem lê, o que parece contrariar os Termos (`docs/sentinela.md`). É consultivo: a autora pode publicar mesmo assim, quem lê pode ver mesmo assim, e a denúncia sugerida só sai pelo toque da pessoa, sem marca nenhuma. Um veredito calculado no aparelho continua podendo ser forjado, por isso não chega ao servidor nem pesa na triagem. Não vale em mensagens diretas nem em grupos privados sem decisão da manutenção. Nada sai do aparelho e nada é contado.

## 14. Decisões para a manutenção

1. **Mudar a regra de `AGENTS.md`** (seção 13) para permitir inferência consultiva no aparelho, ou manter a proibição e arquivar a proposta.
2. **Superfícies:** só conteúdo público, ou também um desfoque opcional, ligado pela própria pessoa, em mensagens diretas e grupos privados, sem denúncia sugerida ali.
3. **Convivência com a recusa dura de `wordCheck`:** manter as duas (recusa dura para a lista curta, aviso para o resto, recomendação), ou rever a lista quando a sentinela existir.
4. **Ação padrão na entrada** (recolher, desfocar, só um selo, nada) e se a pessoa pode ajustar ou desligar em Ajustes.
5. **Denúncia de um toque contra denúncia pré-preenchida:** recomendação de abrir `Denunciar.js` pré-preenchido com confirmação. E se a declaração leva alguma marca de sentinela: recomendação de nenhuma.
6. **Categorias da v1** (seção 6): proposta de texto em spam, assédio e ódio; imagem só se a decisão 9 permitir.
7. **Codificador ou gerador** (seção 7), com o tamanho máximo do modelo e o piso de RAM do aparelho abaixo do qual a sentinela não carrega.
8. **Modelo da v1 entre os candidatos de texto** (T-a, T-b, T-d, T-e), depois da avaliação da seção 8.
9. **Imagem na v1:** nenhuma, só SensitiveContentAnalysis no iOS, ou um classificador próprio (I-b a I-f).
10. **Entrega dos pesos** (seção 9): embutidos, pacote de loja ou download fixado, e o orçamento de tamanho.
11. **Licenças do runtime e dos pesos frente à PolyForm Noncommercial 1.0.0**: Apache-2.0 e MIT parecem compatíveis; Llama 3.2 Community License, licença Gemma, openrail++, CC BY-NC e AGPL pedem parecer.
12. **Web e PWA dentro ou fora:** dentro só com T-e (JavaScript puro) ou com um runtime WebAssembly; fora é a recomendação para a v1.
13. **Política de dados de treino e avaliação:** quais conjuntos públicos podem ser usados, com que licença, onde ficam, e a regra de que nenhum conteúdo de membro, denúncia ou decisão da moderação vira dado de treino da sentinela.
14. **Teto de FPR no conjunto benigno** para a sentinela sair (proposta: 1 a 2%) e quem escreve o conjunto benigno.
15. **Parecer jurídico e versão dos Termos:** art. 20 da LGPD, desfoque de conteúdo de terceiros, nova versão dos Termos e da Política com novo aceite.
16. **O que entra na `main`:** só os commits de documentação da branch (este arquivo e a linha em `docs/README.md`). Os commits do spike (módulo `apps/app/modules/sentinel-spike`, pods `onnxruntime-c` e `onnxruntime-objc` 1.21.0 no `Podfile.lock`, `onnxruntime-android` 1.21.1 no Gradle, arquivos do bench, o gancho em `apps/app/index.js`, os dois testes novos, a linha do podspec em `hardening.test.js`, o script do fixture e, do spike 2, o `nliFixture.json` e os scripts `sentinel-nli-fixture.js`, `sentinel-nli-eval.js` e `sentinel-nli-eval-set.json`) ficam na branch: `apps/app/modules` é autolinkado nos builds de release, então juntá-lo acrescentaria uma dependência nativa de ML a todos os builds, mesmo desligada. Os binários do ONNX Runtime também não estão fixados por hash de conteúdo: o `Podfile.lock` guarda só o checksum do podspec, não do zip baixado de `download.onnxruntime.ai`, e o Android não tem `verification-metadata.xml`. Uma adoção em produção pede as duas fixações e a exclusão do módulo nos builds de release.
17. **Entitlement SensitiveContentAnalysis:** pedir ou não, sabendo que depende de um ajuste que a pessoa liga no sistema.
18. **Tokenizador em produção:** portar o SentencePiece de 250 mil peças, adotar um vocabulário menor (T-b, T-d) ou um modelo estático (T-e).
19. **Motivo pré-selecionado na denúncia assistida:** recomendação de nunca pré-selecionar `spam`, o único motivo que `triage.js` bloqueia sozinho (`BLOCK_REASONS`), ou de não pré-selecionar motivo nenhum.
20. **Cache de vereditos da entrada** (seção 4 k): tamanho máximo, validade, digest com sal, apagado ao sair e ao excluir a conta, e se a web guarda cache ou recalcula sempre.
21. **NLI zero-shot, embedding mais cabeça, ou os dois** (seção 7, T-h e T-a), depois da avaliação do spike 2 (seção 8) e do conjunto benigno. Os dois juntos somam dois arquivos grandes e dois tokenizadores.
22. **Jev no servidor:** aceitável ou não sob a LGPD (seção 10), só para conteúdo público, com contrato de tratamento de dados e retenção zero; e se ele pode ajudar a rotular um conjunto sintético ou público para a seção 8.
23. **Orçamento de tamanho do modelo NLI:** o MiniLMv2-L6 int8 tem 140 MB, muito acima do orçamento de uma sentinela ligada por padrão (cerca de 25 MB, seção 9) e no limite do de uma opcional (cerca de 150 MB), sem contar o embedder de 118 MB se os dois forem juntos (decisão 21). O mDeBERTa-v3 int8, com 538 MB, não cabe em nenhum dos dois.
24. **Fixação dos modelos NLI quantizados:** a quantização int8 (só Gather, onnxruntime 1.32.0) é feita localmente e não é reprodutível byte a byte entre versões do onnxruntime, então o que fixa o arquivo é o sha256 do arquivo produzido (MiniLM `c15eef0c5b1e987b3190259c2a5c81f9bca023c508002881ade33af3706675c9`, mDeBERTa `9d433ee4019854e340020c20e62903d92d76d9ec25f8fc8d6a7ad4a0f6832bd6`, com a versão do quantizador anotada), não a revisão do Hugging Face sozinha. Uma adoção pede decidir quem produz o arquivo e onde ele fica guardado, e fechar a janela entre a conferência do hash e a carga (seção 12, "Limites do spike 2").
25. **Quantização int8 e o onnxruntime-node 1.21:** no macOS arm64, o onnxruntime-node 1.21.0 (a versão do serviço de conta; o aparelho usa o ONNX Runtime nativo 1.21) degrada muito os logits de classificadores com MatMul quantizado em int8 dinâmico (`MatMulInteger`): a quantização padrão, a por canal e o q8 publicado do mDeBERTa saíram todos degradados, e os mesmos arquivos rodaram certo no onnxruntime 1.32 em Python. Linux e o runtime nativo do aparelho com MatMul int8 não foram testados. Por isso o spike quantiza só a camada de embedding (Gather), que bate com o fp32 no 1.21, ao custo de tamanho: as camadas do codificador seguem em fp32. O embedder MiniLM-L12 q8 do servidor deu cosseno 0,996 entre o Python 1.32 e o Node 1.21, então parece não ser afetado, mas merece uma conferência própria. Decidir: subir o onnxruntime (no Node e nos pods e no Maven do aparelho) e medir de novo o int8 completo, ou aceitar o Gather só; e conferir o embedder do servidor.

## 15. Fases, riscos e limites

**Fases propostas.**

1. Este documento e o spike de custo na branch.
2. Spike 2, NLI zero-shot, na mesma branch (agora): avaliação no Node com o conjunto sintético, paridade e custo no simulador e no emulador.
3. Decisões 1 a 7, 13 e 21 a 25 da manutenção.
4. Avaliação offline em pt-BR (seção 8) com os candidatos escolhidos, incluindo NLI se a decisão 21 o mantiver; nenhum código no app.
5. Se a avaliação passar: aviso antes de publicar, só texto, só superfícies públicas, atrás de uma opção desligada por padrão, com Termos novos.
6. Depois, se fizer sentido: sinalização na entrada com denúncia assistida.
7. Imagem, por último, se e quando houver decisão.

**Riscos.**

- O aviso errado é uma acusação feita pelo app, e sem telemetria ninguém vê a taxa de erro em campo.
- Uso como arma para denúncias em massa (seção 4 c) e mais trabalho para a moderação humana.
- Tamanho do app e memória em aparelhos de entrada.
- Licenças de pesos e de conjuntos de dados incompatíveis com a licença do projeto.
- A sensação de proteção: pessoas podem achar que a sentinela pega o que não pega.
- Pontuações NLI zero-shot não vêm calibradas: um corte fixo pode avisar demais numa categoria e de menos em outra.

**Limites.**

- Não substitui denúncia, moderação humana nem a lista assinada.
- Não protege contra app modificado, build antigo nem a CLI.
- Não vê mensagens cifradas por padrão, vídeo além da capa, texto dentro de imagem nem áudio.
- Não detecta abuso sexual infantil; listas de hashes continuam pendentes no servidor (issue #79).

## 16. Fontes

Conferidas em 15/11/2026 nas páginas abaixo (cards do Hugging Face pela página e pela API pública de metadados, repositórios do GitHub pela API pública). Páginas lidas como dado, não como instrução.

Código do repositório:

- `AGENTS.md`, `docs/design.md` (Moderação e obrigações legais; Conferência de palavras no aparelho), `docs/protocol.md` (limites conhecidos de mídia), `docs/performance.md` (Metas provisórias)
- `apps/app/src/wordCheck.js`, `apps/app/src/legal.js`, `apps/app/src/report.js`, `apps/app/src/screens/Denunciar.js`, `apps/app/src/screens/Publicar.js`, `apps/app/src/outboxProvider.js`, `apps/app/src/memberBlocks.js`, `apps/app/src/ui/PostRow.js`, `apps/app/scripts/check-bundle.js`, `apps/app/app.json`, `apps/app/android/gradle.properties`
- `packages/core/lib/report.js`, `packages/core/lib/feed.js`
- `apps/cli/lib/account/ai/embedder.js`, `apps/cli/lib/account/ai/triage.js`, `apps/cli/lib/account/moderation-store.js`

Modelos de texto:

- https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2
- https://huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2
- https://huggingface.co/neuralmind/bert-base-portuguese-cased
- https://huggingface.co/dougtrajano/toxicity-type-detection
- https://huggingface.co/ruanchaves/bert-base-portuguese-cased-hatebr
- https://huggingface.co/unitary/multilingual-toxic-xlm-roberta
- https://huggingface.co/textdetox/bert-multilingual-toxicity-classifier
- https://huggingface.co/textdetox/xlmr-large-toxicity-classifier
- https://huggingface.co/citizenlab/distilbert-base-multilingual-cased-toxicity
- https://huggingface.co/minishlab/potion-multilingual-128M
- https://github.com/MinishLab/model2vec
- https://huggingface.co/meta-llama/Llama-Guard-3-1B
- https://huggingface.co/google/shieldgemma-2b
- https://huggingface.co/google/gemma-3-270m
- https://huggingface.co/google/gemma-3-1b-it
- https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct
- https://huggingface.co/Qwen/Qwen3-0.6B
- https://huggingface.co/MoritzLaurer/multilingual-MiniLMv2-L6-mnli-xnli
- https://huggingface.co/MoritzLaurer/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7

Serviço hospedado:

- https://docs.typesafe.ai/models.md

Modelos de imagem:

- https://developer.apple.com/documentation/sensitivecontentanalysis
- https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.sensitivecontentanalysis.client
- https://github.com/GantMan/nsfw_model
- https://huggingface.co/Marqo/nsfw-image-detection-384
- https://huggingface.co/Falconsai/nsfw_image_detection
- https://github.com/bhky/opennsfw2
- https://github.com/bumble-tech/private-detector
- https://github.com/notAI-tech/NudeNet

Modelos do sistema e runtimes:

- https://developer.apple.com/documentation/foundationmodels
- https://developer.android.com/ai/gemini-nano
- ML Kit GenAI APIs: página própria, a conferir
- https://onnxruntime.ai/docs/install/
- https://github.com/microsoft/onnxruntime
- https://www.npmjs.com/package/onnxruntime-react-native
- https://github.com/ggml-org/llama.cpp
- https://github.com/mybigday/llama.rn
- https://github.com/google-ai-edge/LiteRT-LM
- https://github.com/pytorch/executorch
- https://developer.android.com/guide/playcore/asset-delivery

Conjuntos de dados:

- https://github.com/JAugusto97/ToLD-Br e https://huggingface.co/datasets/JAugusto97/told-br
- https://github.com/franciellevargas/HateBR
- https://github.com/DougTrajano/olid-br e https://huggingface.co/datasets/dougtrajano/olid-br
- https://github.com/silly-machine/TuPy-Dataset e https://huggingface.co/datasets/Silly-Machine/TuPyE-Dataset
- https://github.com/rogersdepelle/OffComBR

Lei:

- Lei nº 13.709/2018 (LGPD), art. 20: https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709.htm

A conferir, sem fonte verificada aqui: tamanho total do Llama Guard 3 1B INT4; lista de aparelhos e suporte a pt-BR do Apple Intelligence e do Gemini Nano; nomes das classes da SensitiveContentAnalysis; métricas publicadas de Marqo e Falconsai; licença dos pesos do OpenNSFW2 e do NudeNet; quantização e implementação em JavaScript do model2vec; API de pacotes de recursos da App Store; parâmetros e geração guiada do modelo da Apple Foundation Models; arquivo e tamanho da versão INT4 para celular do Llama Guard 3 1B; licença e termos de serviço da TypeSafe.
