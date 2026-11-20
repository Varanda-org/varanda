# Hashtags tocáveis (PR feat/hashtags)

Este arquivo confere o `#palavra` tocável em publicações públicas e a tela Assunto (id `assunto`, título `#palavra`), onde o nó é hospedado (web hospedada e app instalado). Rodada ainda por fazer.

- [ ] Em publicações públicas, um `#palavra` aparece como tocável (começo do texto ou depois de um caractere que não é de palavra); `#` sozinho, `#` dentro de um endereço (URL, também `exemplo.com/#secao`, sem esquema) e `#` com um único caractere não são tocáveis. `#Céu` abre a tela com a palavra dobrada `ceu`.
- [ ] Legenda recolhida e cartão da citação (cortado em 6 linhas): o `#palavra` segue como texto, como os links; na legenda aberta ele é tocável.
- [ ] Em conversas privadas e em grupos privados, `#palavra` não é tocável. No app com configuração manual e na web com `varanda-serve` também não.
- [ ] A tela abre com o título `#palavra`, lista as publicações em ordem cronológica pela data da própria publicação (da mais nova para a mais antiga; empate por autor e depois por número; uma data à frente do relógio do aparelho conta como agora), e o estado vazio traz texto simples.
- [ ] O app é mais estrito que a Busca: uma publicação que traz só a palavra solta (sem o `#`) no texto verificado não aparece na tela Assunto, mas aparece ao digitar a palavra na Busca.
- [ ] Uma publicação com data mais de 24 h no futuro não aparece.
- [ ] Uma ação (abrir a página, puxar para atualizar, **Ver mais**) lê no máximo 3 páginas do índice e relê no máximo 30 publicações; uma página cortada por esse limite é lida de novo na ação seguinte, que só relê o que faltou. Depois aparece **Ver mais**; só uma página final encerra a lista.
- [ ] Sem contagens, sem assuntos do momento e sem sugestões em lugar nenhum da tela.
- [ ] Rede: o pedido ao abrir a página é `GET /index/topic/<palavra>`, igual ao de digitar a palavra na Busca, seguido de leituras `diary.peek`; nenhuma mudança no semeador. Quando o nó reconecta, cada tela Assunto aberta na pilha pede de novo, sem toque.
- [ ] Autor bloqueado: a publicação não aparece e não conta para "Algumas publicações podem faltar.". O app só planeja leituras depois de carregar a lista de bloqueios e deixa de fora os autores bloqueados; se a lista não pôde ser lida, o nó recusa a leitura desses autores e a linha não aparece.
- [ ] Puxar para atualizar sem rede, com a lista já carregada: a lista continua na tela e só aparece o erro; "Tentar de novo" atualiza de novo, sem carregar páginas mais antigas.
- [ ] Puxar para atualizar enquanto **Ver mais** carrega: a atualização vence e a lista recomeça.
- [ ] Com a lista vazia já carregada, "continuar busca" mostra o indicador de carregamento embaixo do estado vazio.
- [ ] "Ainda preparando a pesquisa…" e "Algumas publicações podem faltar." aparecem também com a lista vazia.
- [ ] Claro e escuro, 375x812 e 1280x800: os botões da tela com alvo de 44 pt, sem texto cortado, leitor de tela lê o `#palavra` como link ("Abrir assunto #palavra"). O `#palavra` no texto é um link dentro da linha, como o `@nome` e os endereços: o alvo é o próprio texto, sem os 44 pt (a exceção dos links no texto, em docs/design-review.md).
- [ ] Os Termos e a Privacidade estão na versão 56 e pedem novo aceite; o texto da Privacidade diz que, na versão web hospedada e no app instalado, abrir a página de uma hashtag (e de novo quando o app reconecta com ela aberta) pede ao semeador as publicações com essa palavra, que o semeador vê a palavra e o endereço da conexão, que o app depois relê essas publicações pela conexão em que já se identificou com a conta, de modo que o semeador pode associar a palavra e essas publicações à conta, e que o registro de erros do servidor web pode guardar o endereço pedido, com a palavra, quando o serviço falha.
