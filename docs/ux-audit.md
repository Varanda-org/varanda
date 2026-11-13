# Auditoria de UX do app

Leitura do código de `apps/app/src` (não é uma caminhada visual) que abre a série de PRs da revisão de interface. Cada achado diz o que a pessoa vê hoje, a mudança proposta e o PR da pilha que a entrega. O que ainda depende de olhar a tela está marcado "a confirmar na verificação": a verificação de cada PR confirma ou descarta.

## Método

O ciclo é o de [design-review.md](design-review.md): Vitrine (`EXPO_PUBLIC_VARANDA_VITRINE=1`), Android no AVD `varanda-api36`, iOS no iPhone 16e, Chrome em 390 px e 1280 px, claro e escuro. As capturas ficam fora do git (design-review.md, seção "Evidências"). A lista de verificação comum está no fim, em "Checklist VC".

Dono de cada achado:

| PR | Assunto |
|---|---|
| PR2 | Legendas e carrossel (`PostRow`, `MediaCarousel`) |
| PR3 | Conversas de publicação, barra de resposta, prévias em A Rua |
| PR4 | Navegar na Feira (`Feira.js`, `feiraScreen.js`) |
| PR5 | Anúncio, Anunciar em passos, oferta |
| PR6 | Formatação do chat (`Bubble`, `ChatComposer`, prévias) |
| PR7 | Reações em grupo |
| PR8 | Reações em conversa |
| PR9 | Caixa de entrada, comunidades, deslizar para responder, ir para o fim |
| PR10 | Feeds, busca, perfil, avisos, publicar, Momentos, introdução, ajustes |

Achado fora desse mapa fica "adiado", com o motivo.

Os estados foram fechados em 2026-11-12, no fim da pilha (PR1 a PR10): a última coluna deixou de nomear o PR dono e passou a dizer o que aconteceu. "feito (PRn)" é o que o código mostra; "feito em parte (PRn)" diz o que ficou de fora; "adiado" diz por quê. UX-49 e UX-63 seguem como estavam (já atendiam). A leitura foi feita no código, não numa caminhada: a verificação manual de cada PR está na seção correspondente de `verification.md`.

## 1. Post e legenda

Arquivos: `apps/app/src/ui/PostRow.js`, `apps/app/src/ui/MediaCarousel.js`.

| Id | Onde | Hoje | Mudança proposta | Dono |
|---|---|---|---|---|
| UX-01 | `PostRow.js:329` | O texto inteiro da publicação entra no feed, sem limite de linhas nem "ver mais". Uma legenda longa empurra a ação e a próxima publicação para baixo. | Cortar a legenda em poucas linhas com "ver mais" que expande no lugar, sem abrir a conversa. | feito (PR2) |
| UX-02 | `PostRow.js:342` | A mídia usa `MediaGrid`; o `MediaCarousel` existe como componente separado. A relação entre os dois (quando a grade vira carrossel) precisa ser conferida. | Uma só regra: duas ou mais fotos rolam no carrossel, com a legenda sempre abaixo e do mesmo tamanho. A confirmar na verificação. | feito (PR2) |
| UX-03 | `MediaCarousel.js:403` | O ponto de página mede 6 pt, abaixo do que se lê com o polegar em foto clara. | Pontos maiores com contraste do token de contorno nos dois temas. | feito em parte (PR2): a cor vem do token de acento e o carrossel mostra no máximo 5 pontos, mas o ponto segue com 6 pt |
| UX-04 | `MediaCarousel.js:408` | O ponto ativo no escuro usa a cor literal `#ffffff` e `rgba(255,255,255,0.4)`, fora dos tokens do tema. | Trocar por tokens de `theme.js`. A confirmar se `themeUsage.test.js` isenta o arquivo. | feito em parte (PR2): o ponto ativo claro usa token; sobre foto escura o ponto e as setas seguem em `#ffffff` |
| UX-05 | `MediaCarousel.js:295`, `:307` | As setas anterior e próxima têm rótulo (`foto anterior`, `próxima foto`), mas o rótulo não diz a posição. | Anunciar "foto 2 de 5" ao mudar de página para o leitor de tela. | feito em parte (PR2): o contador "N de M" aparece a cada troca, mas o rótulo das setas segue sem a posição |
| UX-06 | `PostRow.js:358`, `:423`, `:436`, `:448` | Vários toques do cabeçalho usam `hitSlop={4}`, abaixo dos 44 pt que o resto do app usa. | Subir a área de toque do nome, do handle e do "republicou" ao mínimo de `layout.hit`. | feito em parte (PR2): a legenda tem alvo de 44 pt; os toques do cabeçalho seguem com `hitSlop` de 4 a 6 pt |
| UX-07 | `PostRow.js:439` | A hora corta em uma linha (`numberOfLines={1}`) com fonte grande, e some antes do nome. | Dar prioridade ao nome e deixar a hora quebrar para a linha de baixo com fonte 1.3. A confirmar na verificação. | feito (PR2) |

## 2. Conversa e respostas

Arquivos: `apps/app/src/screens/Conversa.js`, `apps/app/src/ui/ReplyPreview.js`, `apps/app/src/screens/ARua.js`.

| Id | Onde | Hoje | Mudança proposta | Dono |
|---|---|---|---|---|
| UX-08 | `Conversa.js:887` | As respostas entram numa lista plana, sem recuo nem ligação visual com a publicação respondida. A pessoa não vê quem respondeu a quem. | Fio vertical e recuo de um nível para as respostas diretas; respostas de respostas ficam no mesmo nível, com a prévia do alvo. | feito (PR3) |
| UX-09 | `Conversa.js:845` | A publicação aberta já tem barra lateral de destaque (`Conversa.js:847`, `:923`) e o pai fica mais discreto (`opacity: 0.72`, `:921`), mas o pai ainda parece uma linha de feed comum, sem rótulo de contexto. | Manter a barra e a opacidade; dar ao pai um rótulo curto de contexto ("Em resposta a") e ligá-lo à publicação aberta pelo fio das respostas. | feito em parte (PR3): o pai segue sem o rótulo "Em resposta a"; o chip "Respondendo a Nome" liga à publicação respondida |
| UX-10 | `Conversa.js:579` | Responder sai pela ação da linha e leva a pessoa para outra tela (compor). Não há barra de resposta na própria conversa. | Barra de resposta fixa embaixo da conversa, com o alvo citado e Cancelar, reutilizando o padrão do `ChatComposer`. | feito (PR3) |
| UX-11 | `Conversa.js:871` | Os avisos de lista incompleta e de itens indisponíveis empilham `Soft` soltos no meio da lista. | Uma só nota, no rodapé, com o motivo mais importante. | feito (PR3) |
| UX-12 | `PostRow.js:480` | O chip "responder" é só um ícone com contagem na barra de ações; não mostra a quem a resposta vai. | O chip de resposta (`replyToName`) vira toque que leva ao post pai. A confirmar o que `onOpenParent` faz hoje. | feito (PR3) |
| UX-13 | `ARua.js:1374` | Um post indisponível aparece como linha de nova tentativa; a prévia da resposta some do feed. | Mostrar a prévia do alvo mesmo quando indisponível ("publicação indisponível") sem quebrar o ritmo da lista. | feito (PR3) |
| UX-14 | `ReplyPreview.js` | A prévia corta o texto em 2 linhas e tem só dois alvos de toque; fonte grande pode cortar o nome. | Garantir nome em uma linha e texto em duas com `ellipsizeMode`; conferir com fonte 1.3. | feito (PR3) |

## 3. Feira

Arquivos: `apps/app/src/screens/Feira.js`, `apps/app/src/feiraScreen.js`, `apps/app/src/ui/ListingCard.js`.

| Id | Onde | Hoje | Mudança proposta | Dono |
|---|---|---|---|---|
| UX-15 | `Feira.js:231` a `:238` | UF, cidade, palavras, tipo e categoria ficam num bloco só; a pessoa digita a cidade antes de ver qualquer anúncio. | Mostrar os anúncios primeiro; filtros num painel recolhido com resumo ("São Paulo, SP, Todos"). | feito (PR4) |
| UX-16 | `Feira.js:233` | Cidade é texto livre; um erro de digitação devolve lista vazia sem dizer por quê. | Sugestões a partir da cidade lembrada e mensagem "nada em <cidade>" com atalho para limpar. A confirmar o texto de vazio. | feito em parte (PR4): o vazio tem "Limpar filtros" e "Trocar cidade", mas não há sugestão de cidade lembrada |
| UX-17 | `Feira.js:246` | Parágrafo único e longo explica contagens, intervalo de 15 minutos e offline. | Dividir em frases curtas; mover o detalhe técnico para a folha de ajuda (`Help`). | feito (PR4) |
| UX-18 | `Feira.js:215` | A troca de segmento usa `FilterChips`, o mesmo componente dos filtros: dois níveis de navegação parecem iguais. | Usar `Segmented` para o segmento e chips só para filtro. | adiado: o segmento (Na cidade, Buscas, Meus, Salvos) segue em `FilterChips`, o mesmo componente dos filtros |
| UX-19 | `Feira.js:247` | "Você ainda não tem buscas salvas neste aparelho" sem ação. | Estado vazio com o passo seguinte: "Busque e salve para ser avisado". | adiado: segue "Você ainda não tem buscas salvas neste aparelho." sem ação |
| UX-20 | `Feira.js:274` | A lista usa `ListingCard` sem separar "novos desde a última visita". | Marcar o que chegou desde a última abertura. A confirmar com dado da Vitrine. | feito em parte (PR4): "N novos" só nas buscas salvas; a lista não marca o que chegou desde a última visita |
| UX-21 | `Feira.js:294` | O botão flutuante "Anunciar" limita a fonte (`TEXT_CAP`) e pode cobrir o último card. | Reservar espaço no fim da lista (`useBottomPad`) e conferir com fonte 1.3. | feito (PR4) |

## 4. Anúncio e Anunciar

Arquivos: `apps/app/src/screens/Anuncio.js`, `apps/app/src/screens/Anunciar.js`, `apps/app/src/screens/Mensagem.js`.

| Id | Onde | Hoje | Mudança proposta | Dono |
|---|---|---|---|---|
| UX-22 | `Anunciar.js:254` a `:328` | Um formulário só, de título a fotos, numa rolagem longa; o botão final fica fora de vista. | Passos curtos (o quê, valor, onde, fotos, revisar) com `Stepper` e rascunho mantido. | feito (PR5) |
| UX-23 | `Anunciar.js:307` | O texto "Fotos só podem ser publicadas na versão web." aparece quando não há como anexar. AGENTS.md proíbe esse tipo de aviso num celular com o app instalado. | Decidir por capacidade (`canAttach`) e explicar o que falta sem citar "versão web" no celular. A confirmar quando a condição dispara. | feito (PR5) |
| UX-24 | `Anunciar.js:294` | Tocar numa foto a remove na hora, sem confirmar nem desfazer. | Toque abre a foto; remover vira botão próprio com desfazer. | feito em parte (PR5): remover virou o botão "Remover foto", mas sem desfazer |
| UX-25 | `Anunciar.js:267` | O valor é texto livre com `placeholder='25,00'`, sem teclado numérico declarado. | Teclado numérico e máscara de reais. A confirmar `keyboardType` na verificação. | adiado: o valor segue texto livre com `placeholder` "25,00", sem máscara de reais |
| UX-26 | `Anunciar.js:284` | UF é campo de duas letras livres. | Seletor de UF como o `FilterChips` da Feira. | adiado: a UF segue um campo livre de duas letras |
| UX-27 | `Anuncio.js:286` a `:298` | Local, categoria, @nome e linhas de avaliação são `Soft` empilhados com o mesmo peso. | Hierarquia: preço e título, depois local e categoria como metadados, depois o vendedor num cartão. | feito (PR5) |
| UX-28 | `Mensagem.js:39` a `:46` | "Fazer oferta" só aparece depois de um link de anúncio na conversa; quem vê o anúncio não tem um caminho direto. | Botão "Fazer oferta" no `Anuncio`, que abre a conversa com a oferta já preenchida. | feito (PR5) |

## 5. Chat (Grupo e Mensagem)

Arquivos: `apps/app/src/ui/Bubble.js`, `apps/app/src/ui/ChatComposer.js`, `apps/app/src/screens/Grupo.js`, `apps/app/src/screens/Mensagem.js`.

| Id | Onde | Hoje | Mudança proposta | Dono |
|---|---|---|---|---|
| UX-29 | `Bubble.js:117` | O texto da bolha passa por `MentionText` (links e @nome); não há negrito, itálico nem código. | Formatação leve (`*negrito*`, `_itálico_`, crase) processada em módulo puro, nunca em texto de par cru. | feito (PR6) |
| UX-30 | `Bubble.js:273`, `:274` | Hora e estado em 11 pt, dentro da bolha, com `lineHeight` fixo; some em fonte grande ou fundo escuro. | Subir para 12 pt e conferir o contraste do token `soft` nos dois temas. | adiado: hora e estado da bolha seguem em 11 pt |
| UX-31 | `ChatComposer.js:615` | O campo já cresce até `MAX_HEIGHT` (`ChatComposer.js:87`) e rola por dentro a partir dele (`:617`). Ao abrir a fileira de formatação, essa altura passa a dividir espaço com os botões novos. | Manter o limite; a fileira de formatação aparece acima do campo sem reduzir a altura máxima, e some quando o teclado fecha. A confirmar na verificação. | feito (PR6) |
| UX-32 | `ChatComposer.js:561` | O alvo da resposta aparece na barra via `ReplyPreview`, mas o toque na barra não rola até a mensagem original. | Tocar na barra de resposta rola até a mensagem. | adiado: tocar na barra de resposta não rola até a mensagem (só a citação no balão rola, PR9) |
| UX-33 | `Bubble.js:117`, `:138` | Um toque longo abre o menu de ações. Não há reação rápida; a única forma de reagir é responder. | Linha de reações no menu de toque longo, em grupo. | feito (PR7) |
| UX-34 | `Bubble.js:117` (via `Mensagem.js:9`) | A conversa privada usa o mesmo menu, sem reação. | Mesma linha de reações, com o mesmo componente, na conversa um a um. | feito (PR8) |
| UX-35 | `Grupo.js:884` a `:923` | Há `scrollToEnd` por programa, mas nenhum botão "ir para o fim" quando a pessoa rolou para cima e chegam mensagens novas. | Botão flutuante com contagem de novas. | feito (PR9) |
| UX-36 | `Grupo.js:1062` | Fora do nó hospedado, a tela mostra "Só na versão web". Em celular com o app, o aviso é enganoso. | Conferir se o estado só ocorre sem nó hospedado e reformular o texto pela capacidade. A confirmar na verificação. | feito em parte (PR9): Grupo diz "Comunidades indisponíveis" por `node.hosted`; Comunidades e Comunidade ainda mostram "Só na versão web" |

## 6. Conversas, Mensagens, Comunidades

Arquivos: `apps/app/src/screens/Conversas.js`, `apps/app/src/screens/Mensagens.js`, `apps/app/src/screens/Comunidades.js`, `apps/app/src/screens/Comunidade.js`, `apps/app/src/screens/Grupo.js`, `apps/app/src/screens/Mensagem.js`.

| Id | Onde | Hoje | Mudança proposta | Dono |
|---|---|---|---|---|
| UX-37 | `Conversas.js:289`, `:533` a `:535` | Três filtros (Todas, Não lidas, Grupos); cada vazio tem texto próprio, e "Nenhuma conversa encontrada" não diz como limpar a busca. | Vazio com ação "limpar busca" e o mesmo visual do `EmptyState`. | feito (PR9) |
| UX-38 | `Conversas.js` (sem `swipe`) | A linha da conversa só tem toque; fixar, silenciar e arquivar exigem abrir o menu. | Deslizar a linha para ações rápidas, com alternativa por toque longo. | adiado: ficou fora do PR9; fixar, silenciar e arquivar seguem pelo menu |
| UX-39 | `Mensagem.js`, `Grupo.js` (sem `PanResponder`) | Responder exige toque longo e menu. | Deslizar a bolha para a direita para responder, com `PanResponder`, sem dependência nova, e reduzir movimento sem a animação de retorno. | feito (PR9) |
| UX-40 | `Mensagens.js` (sem rótulos de acessibilidade) | A tela de ativar mensagens usa só `Btn` e `Text`; a ordem de leitura é título, nota, botão. | Conferir ordem e títulos de seção para o leitor de tela. A confirmar na verificação. | feito (PR9) |
| UX-41 | `Comunidades.js:400` a `:409` | A busca mostra até seis `Soft` seguidos (buscando, erro, nenhum, parcial, indexando, mais). | Um só estado por vez, com prioridade clara. | feito (PR9) |
| UX-42 | `Comunidades.js:232` | A explicação "até 32 grupos sob a mesma moderação" fica dentro do formulário de criar, que só se vê depois de tocar. | Mostrar no estado vazio da lista, com o botão "Nova comunidade". | feito (PR9) |
| UX-43 | `Comunidade.js:95` | O rótulo da linha do grupo leva a contagem de não lidas, o que ajuda; falta a hora da última mensagem na leitura. | Incluir a hora e o remetente no rótulo, como a linha da conversa. | feito (PR9) |

## 7. A Rua, Espiadinha, Busca, Avisos

Arquivos: `apps/app/src/screens/ARua.js`, `apps/app/src/screens/Espiadinha.js`, `apps/app/src/screens/Busca.js`, `apps/app/src/screens/BuscaGlobal.js`, `apps/app/src/screens/Avisos.js`, `apps/app/src/ui/MomentosStrip.js`.

| Id | Onde | Hoje | Mudança proposta | Dono |
|---|---|---|---|---|
| UX-44 | `ARua.js:1611`, `:2225` | O erro de carga troca a lista inteira por `ErrorState`; já com itens, o erro vem no topo. | Mesmo lugar nos dois casos (faixa no topo, sem trocar a lista). | feito (PR10) |
| UX-45 | `ARua.js:1396` | O toast tem ação (`toastAction`) com `hitSlop={8}`, curto para o polegar. | Área de toque de 44 pt e permanência maior com fonte grande. | feito (PR10) |
| UX-46 | `Espiadinha.js:442`, `:461`, `:470` | Três `Soft` ao redor da lista (resumo, expirou, incompleta). | Uma nota única com o estado atual. | feito (PR10) |
| UX-47 | `Espiadinha.js:479`, `Avisos.js:1001` | Mesmo título "Só na versão web" em duas telas, sem dizer por que nem como resolver. | Texto por capacidade, com a ação possível. A confirmar quando o estado ocorre num celular. | feito (PR10) |
| UX-48 | `Busca.js:264` a `:267` | Até quatro notas (ajuda, indexando, incompleta, removidos) empilham antes dos resultados. | Colapsar em uma nota e deixar o resto na folha de ajuda. | feito (PR10) |
| UX-49 | `Avisos.js:353` | O nome e a frase de ação já ocupam até duas linhas (`numberOfLines={2}`, `Avisos.js:352-356`), então a ação aparece inteira. | Nenhuma mudança sem um caso reproduzido de corte com fonte grande. A confirmar na verificação. | adiado (já atende) |
| UX-50 | `Avisos.js:1007` | O estado "indisponível" passa `body=''`. | Texto de corpo com o motivo. A confirmar o que `EmptyState` faz com corpo vazio. | feito (PR10) |
| UX-51 | `MomentosStrip.js:204` | Cada anel tem 72 pt de largura com nome cortado em uma linha. | Conferir o corte com fonte 1.3 e dar nome completo ao leitor. | feito (PR10) |

## 8. Diário e Membro

Arquivos: `apps/app/src/screens/Diario.js`, `apps/app/src/screens/Membro.js`, `apps/app/src/ui/ProfileHeader.js`, `apps/app/src/ui/ProfileBar.js`.

| Id | Onde | Hoje | Mudança proposta | Dono |
|---|---|---|---|---|
| UX-52 | `Diario.js:154` a `:158` | O estado do envio ("enviando…", "toque para enviar", "vai sair quando a conexão voltar") é `Soft` solto na linha. | Selo de estado com ícone, mesmo no Diário e no Membro. | feito (PR10) |
| UX-53 | `Diario.js:564` | O botão de ajustes tem rótulo `ajustes` em minúsculas, diferente dos demais ("Ajustes"). | Padronizar maiúscula inicial. | feito (PR10) |
| UX-54 | `Membro.js:916` | A região de avaliações tem `accessibilityLabel` num `View` sem `accessible`; o leitor pode não anunciar. | Marcar como região ou título. A confirmar com o leitor de tela. | feito (PR10) |
| UX-55 | `Membro.js:907` | A linha "Anúncios" é um link de texto, sem contagem. | Mostrar a quantidade e uma prévia de capa. | feito em parte (PR10): a linha "Anúncios" segue sem contagem e sem prévia de capa |
| UX-56 | `Membro.js:1166` | "Ainda montando a lista completa…" some em seguida, sem distinguir do vazio. | Barra de progresso discreta e rótulo vivo. | feito (PR10) |
| UX-57 | `ProfileHeader.js:129` | Contagens de seguidores em 15 pt fixos; com fonte grande, quebram o cabeçalho. | Deixar a linha quebrar e conferir com fonte 1.3. | feito (PR10) |
| UX-58 | `ProfileHeader.js:50` | Avatar de 88 pt é fixo; no web 1280 o cabeçalho fica estreito e alto. | Conferir proporção em 390 e 1280. | feito (PR10): avatar de 88 pt abaixo de 640 pt de largura e de 72 pt a partir daí |

## 9. Publicar, Momentos, Introdução, Ajustes

Arquivos: `apps/app/src/screens/Publicar.js`, `apps/app/src/screens/Momentos.js`, `apps/app/src/screens/Introducao.js`, `apps/app/src/ui/Welcome.js`, `apps/app/src/screens/Ajustes.js`.

| Id | Onde | Hoje | Mudança proposta | Dono |
|---|---|---|---|---|
| UX-59 | `Publicar.js:1426` | O campo de texto abre com `autoFocus`; em celular, o teclado cobre a barra de fotos e emojis ao entrar. | Manter o foco, mas deixar a barra acima do teclado. A confirmar na verificação com `keyboardAvoid`. | feito (PR10): ao focar o campo, e quando a linha do contador se move, a tela rola para manter o campo e a barra de fotos e emojis à vista; a barra fica acima do teclado no Android e no iOS (seção 187, passo 14) |
| UX-60 | `Publicar.js:1286` | O contador "n de 200 caracteres" é rótulo de acessibilidade que muda a cada letra. | Anunciar só nos limiares (restam 20, restam 0). A confirmar o ruído no leitor. | feito (PR10) |
| UX-61 | `Publicar.js:1469` | O botão de foto tem rótulo `Foto`, sem dizer a ação. | "Adicionar foto". | feito (PR10) |
| UX-62 | `Momentos.js:703` | O indicador de carga usa a cor literal `#ffffff`. | Token do tema. A confirmar se o teste de tema isenta o arquivo. | feito (PR10) |
| UX-63 | `Momentos.js:561` | Com reduzir movimento, o avanço automático e a animação da barra de progresso já ficam desligados (`autoAdvanceOn`, `Momentos.js:217-220`, e a condição `running`, `:561`). | Nenhuma mudança: o comportamento já atende. | adiado (já atende) |
| UX-64 | `Introducao.js:118`, `:178` | "Pular" em 15 pt fixos, com `hitSlop={8}`. | Área de toque de 44 pt. | feito (PR10) |
| UX-65 | `Ajustes.js:449` a `:455` | Quatro notas `Soft` em sequência (preferência, push, não suportado, dados guardados) sem agrupamento. | Agrupar por tema, um parágrafo cada, com título. | feito (PR10) |
| UX-66 | `Ajustes.js:513` a `:516` | O rótulo da linha de versão junta app, servidor e nota numa frase só, longa para o leitor. | Três itens separados. | feito (PR10) |

## Checklist VC

Cada tarefa de verificação percorre este checklist e relata o que não rodou. Capturas ficam em pasta de evidência fora do git.

- [ ] Android no AVD `varanda-api36`, build de debug: a tela alterada, do início ao fim.
- [ ] iOS no iPhone 16e: a mesma tela.
- [ ] Web em 390 px e 1280 px.
- [ ] Tema claro e tema escuro, em todas as plataformas acima.
- [ ] Fonte grande (escala 1.3): nada cortado, nada sobreposto, botões alcançáveis.
- [ ] Rótulos do leitor de tela: cada controle novo ou alterado tem papel e rótulo; a ordem de leitura faz sentido.
- [ ] Reduzir movimento: animações novas param ou trocam por corte seco.
- [ ] Offline e Vitrine: a tela mostra estado claro sem rede e populada com `EXPO_PUBLIC_VARANDA_VITRINE=1`.
- [ ] Sem travessão (U+2014) em texto novo: `grep -n $'\xe2\x80\x94'` nos arquivos alterados não acha nada.
