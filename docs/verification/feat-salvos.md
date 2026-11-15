# Posts salvos (PR feat/salvos)

Este arquivo confere o menu "mais" de uma publicação (Salvar, Tirar dos salvos) e a tela Posts salvos (id `salvos`), aberta por uma linha no Diário próprio, onde o nó é hospedado (web hospedada e app instalado). Rodada ainda por fazer.

- [ ] No menu "mais" de uma publicação de outra pessoa aparece **Salvar**; ao tocar, o aviso é "Publicação salva." e o mesmo menu passa a mostrar **Tirar dos salvos**, com o aviso "Tirado dos salvos." ao tocar. As próprias publicações também podem ser salvas.
- [ ] **Salvar** não aparece em linhas sem número, em conversas privadas nem em repostagens: numa linha "Fulano republicou" (com a linha do topo com o nome de quem republicou), o menu "mais" não traz Salvar nem Tirar dos salvos, e a publicação original, aberta fora da repostagem, traz.
- [ ] Na web hospedada e no app instalado o Diário próprio mostra a linha Posts salvos; no app com configuração manual e na web com `varanda-serve` a linha não aparece.
- [ ] A tela abre com o título "Posts salvos", lista as publicações salvas com o texto lido de novo do diário de quem escreveu, e o estado vazio traz texto simples. Cada linha mostra o nome e a foto de quem escreveu (não só a chave), inclusive de autores que a pessoa não segue.
- [ ] Autor bloqueado: a publicação vira "Publicação indisponível" com "Tirar dos salvos", e o app nunca lê esse autor (nenhuma leitura `diary.peek` para ele).
- [ ] Publicação apagada ou que não passa na conferência: "Publicação indisponível" com "Tirar dos salvos".
- [ ] Tirar dos salvos pela linha "Publicação indisponível": a linha some, o aviso é "Tirado dos salvos." e a lista continua certa depois de reabrir a tela.
- [ ] Leitura falha (semeador fora do ar, resposta "ocupado" que continua depois das tentativas do app, ou tempo esgotado; sem cópia anterior): uma resposta "ocupado" nunca vira "Publicação indisponível"; a linha mostra "Não deu para conferir agora", sem botão de tirar, e uma nota acima da lista avisa que algumas não puderam ser conferidas. Havendo cópia anterior, ela é mantida. Puxar para atualizar lê de novo e a nota some quando a leitura volta.
- [ ] Salvar com a tela aberta: a linha nova aparece como "Carregando publicação" e depois vira a publicação.
- [ ] Sem rede, a tela mostra "Sem conexão no momento"; a tela de erro só aparece quando toda leitura falha na primeira carga.
- [ ] Salvar a 101ª publicação: o limite de 100 vale e a pessoa recebe o aviso "Você já tem 100 publicações salvas. Tire uma para salvar outra.", sem perder as outras.
- [ ] Oito contas com salvos no mesmo aparelho: ao salvar na nona, a pessoa recebe a mensagem "Este aparelho já guarda salvos de 8 contas. Tire todos os salvos de uma delas para salvar aqui." e nada é apagado.
- [ ] Duas contas no mesmo aparelho (ou duas instalações) têm listas separadas.
- [ ] Tirar a conta do aparelho esquece a lista, em todas as instalações que o aparelho guardava para essa conta; criar ou entrar de novo começa vazia. Sair da conta ("Sair") não esquece a lista: ela continua no aparelho até a conta ser removida dele.
- [ ] No celular, a lista pode entrar no backup do próprio aparelho (o iCloud, no iPhone); a Privacidade diz isso e diz que a lista continua no aparelho depois de "Sair".
- [ ] Rede: nenhuma requisição é feita ao salvar ou ao tirar dos salvos; ao abrir a tela só vêm as leituras de `diary.peek` (elas vão pela conexão em que o app já se identificou, então o semeador pode associar as publicações pedidas à conta) e a busca do perfil de até 10 autores no índice (`/index/member/`, para o nome e a foto), e a lista em si não é enviada.
- [ ] Armazenamento na web: só referências (autor, número, hora), nenhum texto de publicação. No app nativo: o arquivo `varanda-saved-posts.json` nos documentos do app, também só com referências.
- [ ] Claro e escuro, 375x812 e 1280x800: alvos de toque de 44 pt, sem texto cortado, leitor de tela lê Salvar e Tirar dos salvos.
- [ ] Os Termos e a Privacidade estão na versão 54 e pedem novo aceite; o texto de Posts salvos na Privacidade diz que o semeador pode associar as publicações pedidas à conta.
