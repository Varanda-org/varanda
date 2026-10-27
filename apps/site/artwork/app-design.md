# O desenho novo do app

O visual que o app vai ganhar, definido primeiro na página (varanda.app) e depois construído no app. Vale para iOS, Android e web.

**Referência: X e Threads, só no visual.** Mesmas funções de hoje ([docs/app.md](../../docs/app.md)), nenhuma mudança de protocolo. Quente e brasileiro, não uma cópia: creme em vez de branco gelado, verde em vez de azul, a cadeira no topo.

**A referência visual é a própria página:** as classes `.app`, `.post`, `.avatar`, `.app__abas`, `.app__fab`, `.folha` e `.perfil` em [public/styles.css](../public/styles.css), com o HTML em [public/index.html](../public/index.html). Lá, 1 pt = `100cqw / 402` (a tela tem 402 pt de largura, como o iPhone 17 Pro).

## Cores

| Nome | Hex | Uso |
|---|---|---|
| creme | `#fbf8f3` | fundo das telas, barra do topo, barra de abas |
| branco | `#ffffff` | folha de Publicar |
| tinta | `#1f2a24` | texto, nomes, ícones ativos de estado |
| texto suave | `#4a554e` | @nome, tempo, bio, abas inativas, contador, ícone de responder (7,8:1 no branco, 7,3:1 no creme) |
| fio | `rgba(31,42,36,0.10)` | divisórias de 1 pt |
| verde | `#1d6b4f` | ação: botão de publicar, pílula Publicar, aba ativa, nome em "respondendo a", cursor |
| verde claro | `rgba(29,107,79,0.10)` | fundos verdes suaves (reservado; não há mais chip de sincronia) |
| morno | `#fff4e0` | destaques suaves (reservado) |
| listras | `#2a7fb8` `#e8805a` `#f2b705` `#e94e3c` `#1d6b4f` | avatares |
| fim de tarde | `#f7b267 → #e8805a → #8a4e7a → #2b2a4a` | faixa do perfil (gradiente a 170°, como o herói da página) |

## Tipografia

Fonte do sistema (SF no iOS, Roboto no Android, `system-ui` na web). Títulos na variante arredondada quando houver (`ui-rounded`). Tamanhos em pt para 402 pt de largura:

| Peça | Tamanho | Peso | Entrelinha |
|---|---|---|---|
| título da barra ("A Rua") | 21 | 800 | 1,2 |
| nome no perfil | 22 | 800 | 1,2 |
| nome na publicação | 15 | 700 | 1,35 |
| @nome · tempo | 15 | 400 | 1,35 |
| texto da publicação | 15,5 | 400 | 1,38 |
| "respondendo a …" | 13 | 400 (nome 600) | 1,35 |
| texto em Publicar | 18 | 400 | 1,35 |
| pílulas (Publicar, Editar perfil) | 15 | 700 | 1 |
| rótulo de aba | 10 | 600 | 1 |
| contador | 13 | 600 | 1 |
| cabeçalho de seção ("PUBLICAÇÕES") | 13, caixa alta, +0,04 em | 700 | 1 |
| iniciais do avatar | 16 (44 pt), 30 (88 pt) | 700 | 1 |

Cantos arredondados, botões em pílula, entrelinha generosa, nomes em negrito.

## Componentes

- **Barra do topo** (52 pt, fio embaixo): a cadeira (`cadeira.svg`, 32 pt) à esquerda e o título. Não há chip de sincronia nem nenhum estado de conexão com rede.
- **Nota "Sem internet"**: só sem rede, uma linha calma embaixo da barra do topo (ícone de wi-fi cortado em texto suave e "Sem internet"), no fluxo da tela, nunca por cima do conteúdo; no Diário, embaixo da área segura.
- **Nota "Instalar o Varanda"**: uma linha calma embaixo da barra do topo, com o mesmo visual da nota "Sem internet" (fundo quente, texto suave, ícone de celular em linha), no fluxo da tela, nunca por cima do conteúdo; só depois dos passos da primeira configuração, com as abas na tela (os passos não a mostram; Conversa e Membro a cobrem); no Diário, embaixo da área segura; com "Sem internet" junto, ela fica logo embaixo dessa. Só na página hospedada (https) com o nó no navegador, nunca em `localhost` nem com `varanda-serve`, só em celulares e no iPad, nunca em computador, tablet Android nem no app nativo, e nunca com o app já instalado ou aberto como app instalado (standalone, `appinstalled`). Onde o navegador oferece instalar (Chrome no Android): "Instalar o Varanda", o botão "Instalar" (abre o diálogo do próprio navegador a partir do toque) e o controle "Fechar". No Safari do iPhone e do iPad: a orientação "Compartilhar → Adicionar à Tela de Início" e "Fechar", sem botão; outros navegadores do iPhone e navegadores embutidos não mostram nota. Fechar vale neste navegador (`localStorage` `varanda-install-dismissed`) e a nota volta depois de 30 dias; cancelar o diálogo do navegador não inicia os 30 dias, e a nota volta quando o navegador oferecer a instalação de novo. Limite: uma aba do Safari não sabe se o app já foi para a Tela de Início, então ali a nota aparece até ser fechada.
- **Linha de publicação** (`.post`): avatar 44 pt, 12 pt de vão, nome em negrito + `@nome · tempo` na mesma linha (a linha não quebra; o tempo some com reticências se faltar espaço). O negrito é sempre o nome livre do perfil (sem `@` no começo, nem os parecidos) ou, sem nome, o `@nome` escrito como nome (`ana`); o `@nome` em texto suave só aparece quando vem de um registro verificado, então um nome livre como "@ana" nunca se passa pelo `@nome` verificado de outra pessoa. Sem `@nome` verificado, só o tempo; sem nome nem `@nome`, "sem nome" em negrito e o tempo, texto, as fotos (abaixo), e a **barra de ações** (abaixo). O avatar e o nome abrem o perfil; o texto e o tempo abrem a conversa. Preenchimento 12/16/10 pt, divisória de 1 pt entre linhas. **Sem cartões**: a linha do tempo é contínua, como no X e no Threads.
- **Grade de fotos**: embaixo do texto, de 1 a 4 fotos com cantos arredondados e 2 pt de vão: uma mantém a proporção (entre 1:2 e 2:1), duas lado a lado, três como uma grande e duas empilhadas, quatro em 2x2. Enquanto carrega, um quadro suave; sem a foto (app nativo, `varanda-serve`), um quadro neutro "foto"; numa falha, "foto indisponível" e um toque tenta de novo. Um toque abre a tela cheia, com a foto ajustada, setas, teclado e deslizar, o botão de fechar e "foto N de M".
- **Barra de ações**: uma linha horizontal embaixo do texto e das fotos, ícones de linha de 18 pt em texto suave: **responder** (balão), **republicar** (setas; liga e desliga), **citar** e **curtir** (coração; curtido, o coração fica cheio), "seguir" (pessoa com sinal de mais) só na Espiadinha, e "denunciar" (bandeira) por último quando vale. Ao lado de cada ícone, o número só quando ele é conhecido e maior que zero (na web hospedada, vindo do semeador); sem número, só o ícone. Nada de contagem de visualizações.
- **Linha de republicação**: acima do avatar, em 13 pt e texto suave, "Nome republicou" (no Diário, "Você republicou"); a linha abre o perfil de quem republicou, e a publicação embaixo é a original, com as ações dela.
- **Cartão de citação**: dentro da linha, embaixo do texto, um cartão de borda fina (fio) e cantos arredondados com mini avatar, nome, `@nome · tempo`, até 6 linhas do texto citado e as fotos dele; o cartão inteiro abre a publicação citada. Um só nível: uma citada que também cita mostra só "cita outra publicação"; sem a citada, "Publicação indisponível".
- **Marca de resposta**: acima do texto, "respondendo a **Nome**" em 13 pt, o nome em verde. O nome vem do perfil do diário; sem perfil, o `@nome` ou "sem nome" (enquanto o autor não foi consultado, "…"). Nunca a chave.
- **Avatar**: círculo com as duas iniciais do nome ou, sem nome, do `@nome` (primeira letra do primeiro e do último nome); sem nenhum dos dois, um glifo de pessoa, nunca caracteres da chave. A cor continua vindo da chave pública: `primeiro byte mod 5` escolhe nas listras, na ordem azul `#2a7fb8`, laranja `#e8805a`, amarelo `#f2b705`, vermelho `#e94e3c`, verde `#1d6b4f`. Iniciais brancas no azul, no vermelho e no verde; em tinta no laranja e no amarelo (contraste). Assim, com as chaves da demonstração: Marília Prado (`e9…`) vermelho, Bia Carvalho (`16…`) amarelo, Seu Nelson (`0f…`) azul, Helena Dias (`eb…`) azul.
- **Nome e @nome**: o nome é o do perfil do diário e o `@nome` é o registrado na associação. A chave nunca aparece como texto nas listas nem no perfil; só em Ajustes › Avançado › Identidade técnica, atrás de "mostrar chave", e no passo do certificado de membro.
- **Tempo relativo**: "agora", "5 min", "1 h", "ontem", depois a data curta ("12 out").
- **Barra de abas** (83 pt com a área segura, 49 sem): cinco abas com ícone de linha (27 pt) e rótulo (10 pt): **A Rua** (casa), **Espiadinha** (olho), **Seguindo** (duas pessoas), **Avisos** (sino, `sino`), **Diário** (pessoa). Ativa em verde, traço mais grosso; inativas em texto suave. Fundo creme a 94 % (o conteúdo passa por baixo). Quando há um aviso ainda não visto, o ícone de Avisos ganha um ponto verde de 8 pt no canto (sem texto, nunca um número).
- **Avisos**: linhas como as de Seguindo, com avatar, "<nome> começou a seguir você" ("Alguém" sem nome), o `@nome` e o tempo relativo em texto suave, e a pílula verde cheia "Seguir de volta" à direita; ao seguir, a linha sai da lista. Sem contagem, sem lista de seguidores. Estados com ícone de sino: "Ninguém novo por aqui", "Sem conexão", "Sem avisos por aqui" e, no nativo e no `varanda-serve`, "Só na versão web". É o único aviso do app: aparece só dentro dele.
- **Espiadinha**: linhas iguais às da linha do tempo (respostas, citações e republicações incluídas), com fotos e a barra de ações com os números (responder, republicar, citar, curtir), mais seguir (ícone `user-plus`, pessoa com sinal de mais) e denunciar. Uma publicação por diário não seguido (o próprio incluído, sem "seguir") por rodada, até três rodadas; uma linha suave abre cada rodada, a primeira também: "1ª publicação de cada diário", "2ª publicação de cada diário" e "3ª publicação de cada diário". No topo, a explicação curta, "como funciona" para abrir a regra e a nota de que as publicações ficam só na memória. Puxar para atualizar refaz a lista, sem "ver novidades". Só na web hospedada; no nativo e no `varanda-serve`, a aba explica "Só na versão web". Fotos usam a mesma rota `/media` de A Rua, sob demanda, com SHA-256 e cache de endereços `blob:` só em memória; buscadas com `no-store`, nada fica no cache HTTP.
- **Botão de publicar** (`.app__fab`): círculo verde de 56 pt, lápis branco, a 20 pt da direita e 100 pt do fundo, sombra verde. Abre a folha de Publicar.
- **Folha de Publicar** (`.folha`): sobe por cima da tela, que escurece e encolhe um pouco atrás; cantos de 18 pt no topo, fundo branco. Topo de 56 pt: "Cancelar" à esquerda (17 pt), pílula verde **Publicar** à direita (desligada com o texto vazio). Corpo: avatar 40 pt da própria pessoa e a área de texto em 18 pt com o espaço reservado "O que está rolando na varanda?". Embaixo do texto, à direita: anel de progresso (20 pt, verde sobre fio) e o contador `67/1000` (fica vermelho a partir de 1000); à esquerda, as ferramentas: o botão de emoji, que abre logo abaixo do texto um painel compacto (sem segunda folha) com abas de grupos e uma grade de alvos de 44 px, e, na web hospedada com rede, "Foto", que mostra as fotos escolhidas em miniaturas (nada é enviado até "Publicar"; depois, o progresso do envio e "falhou · tentar de novo"). Com fotos, a pílula Publicar liga mesmo sem texto. Responder usa a mesma folha, com a marca "respondendo a Nome" acima do texto; citar também, com "citando Nome" e "cancelar citação" (precisa de internet).
- **Cabeçalho do perfil** (`.perfil`): faixa de 150 pt no gradiente fim de tarde, passando por trás da barra de estado (texto branco ali); engrenagem (34 pt, círculo escuro translúcido) no canto inferior direito da faixa. Avatar de 88 pt com anel creme de 4 pt, sobrepondo a faixa pela metade; à direita, na linha do avatar, a pílula de contorno **Editar perfil**. Depois: nome (22), `@nome`, bio, "**3** seguindo" (o número de diários seguidos é conhecido localmente; **não** há seguidores). Cabeçalho "PUBLICAÇÕES" e só as publicações da pessoa, no mesmo estilo da linha do tempo; registros técnicos não aparecem.
- **Conversa** (por cima das abas, sem a barra de abas): barra do topo com a seta de voltar e "Conversa"; a publicação respondida, mais apagada; a publicação em destaque, com um fio verde de 3 pt à esquerda; o cabeçalho "N respostas" com as notas calmas ("Ainda montando a conversa completa…", "Algumas respostas podem faltar."); todas as respostas, no estilo da linha do tempo, até "Isso é tudo nesta conversa.".
- **Membro** (por cima das abas): seta de voltar e o nome na barra do topo; avatar de 88 pt, nome (22), `@nome`, bio; as pílulas "Seguir" (cheia) / "Seguindo" (contorno) e "denunciar a conta"; depois as publicações e republicações da pessoa, no estilo da linha do tempo. Sem número de seguidores.
- **Seguindo**: lista de linhas com avatar, nome e `@nome` (uma barra de esqueleto enquanto o nome carrega; nunca a chave), e uma pílula "Seguindo" / "Seguir" à direita; o campo "@nome ou chave" fica no topo (na web hospedada, acima dele há o campo "Buscar", com o texto de ajuda "nome ou @nome", e uma pílula "Buscar"; a busca roda 400 ms depois de parar de digitar, e as linhas de resultado têm avatar, nome, `@nome` conferido e "Seguir"/"Seguindo", sem a chave; um toque abre o Membro; avisos curtos em texto suave: "Ninguém encontrado com esse nome.", "Digite pelo menos 2 letras.", "Há mais gente com esse nome. Tente um nome mais específico.", "A busca precisa de internet.", "Ainda montando a lista; alguém pode faltar.", "Não deu para conferir todo mundo agora.", "Algumas pessoas não puderam ser conferidas agora.", "A busca ainda não está disponível.", "Não foi possível buscar agora."; no máximo 20 linhas, sem a própria conta e sem bloqueados), o cabeçalho diz "N pessoas" e uma nota curta diz que quem a pessoa segue é público e igual em todos os aparelhos; paginação como hoje.
- **Ajustes** (engrenagem): a lista principal, para pessoas, com **Editar perfil**, **Conta e @nome**, **Guardar dados neste aparelho**, **Instalar o app** (mantém o texto; sempre que o navegador oferece instalar na página hospedada, ganha também o botão "Instalar" acima do texto, até em computador e depois de fechar a nota do topo; o app nativo não ganha nada) e, à parte, **Sair** (confirmação em linha); embaixo, a linha recolhida **Avançado**, que abre **Conexão**, **Sincronização**, **Identidade técnica** e **Recomeçar**. Sincronização é só leitura: o estado em uma expressão (o texto do antigo chip), o da rodada (contínua ou única, recuperando, parada), a última parada, "nova tentativa em n s", as últimas linhas do registro e "Atualiza sozinho enquanto o app está aberto e com rede."; não há botão de sincronizar.
- **Puxar para atualizar**: nas listas, no nativo (controle de atualização do sistema), na web com toque (gesto de puxar, indicador de 36 pt, limiar de 72 px) e no computador com a roda do mouse ou o trackpad no topo da lista; não há barra "Atualizar" visível, só um botão "Atualizar" escondido que aparece com o foco do teclado.
- **Rolagem infinita**: A Rua e Espiadinha carregam 30 e depois páginas de 31, o Diário páginas de 36, Seguindo de 50, uma carga por chegada ao fim (cursores nas publicações; posição na lista de seguidos). Rodapé discreto: "Isso é tudo por enquanto." (A Rua, Espiadinha e Diário); uma página que falhou só tenta de novo por ação da pessoa ("tentar de novo" ou "mostrar mais").
- **Pílula de novidades**: "ver novidades", no topo de A Rua e Diário, quando chegaram dados novos; é uma dica, nunca uma contagem, e a lista não recarrega sozinha. A Espiadinha não tem essa pílula. O mesmo vale para a dica de novidade de Avisos: o ponto na aba, sem número.
- **Estados vazios**: um ícone de linha, um título e uma frase curta com uma ação quando houver ("A Rua está vazia", "Ainda não chegou nada", "Você ainda não segue ninguém", "Você ainda não publicou"); erro de carregamento com a mensagem e "tentar de novo".
- **Esqueleto de carregamento**: barras suaves no lugar das linhas (e do nome) enquanto carregam, sem rodinha girando.
- **Primeiros passos**: a primeira configuração é um passo a passo com "Passo n de 3". Na web: "Bem-vindo à Varanda", "Escolha seu @nome", "Como você quer aparecer"; no nativo e no `varanda-serve`: "Sua identidade", "Certificado de membro", "Como você quer aparecer". O nome e a bio são opcionais ("Pular por enquanto"); ao terminar, "Tudo pronto. Siga pessoas para encher a Rua."
- **Estado de conexão**: só a nota "Sem internet" sem rede e, em detalhe, Ajustes › Avançado › Conexão e Sincronização; nenhum banner sobre a linha do tempo. A nota "Instalar o Varanda" não é um estado de conexão e, como "Sem internet", fica no fluxo da tela.
- **Aguardando envio**: uma publicação esperando na fila de saída é uma linha no Diário, na seção "Aguardando envio", nunca um cartão em A Rua e nunca um banner.

## Navegação

Cinco abas + o botão de publicar + os ajustes. Onde ficam as telas:

| Tela de hoje | Onde fica |
|---|---|
| A Rua | aba A Rua |
| Espiadinha | aba Espiadinha |
| Seguindo | aba Seguindo |
| Avisos | aba Avisos (sino), com um ponto quando há novidade |
| Diário | aba Diário (o perfil em cima, as publicações embaixo) |
| Perfil | aba Diário › Editar perfil |
| Publicar | botão de publicar (folha); responder a partir de qualquer publicação |
| Sincronizar | Ajustes › Avançado › Sincronização, só leitura |
| Conexão | Ajustes › Avançado › Conexão (no app nativo, também a tela Conectar da primeira vez) |
| Identidade | Ajustes › Conta e @nome e Ajustes › Avançado › Identidade técnica |

A primeira configuração (Conectar, criar identidade, certificado, nome) é o passo a passo "Primeiros passos", antes das abas aparecerem.

## O que fica de fora, de propósito

Não desenhar, nem como enfeite, nada que o app não faz: contagens de visualização, vídeos, número de seguidores, notificações do sistema, mensagens diretas, busca de assuntos. A única busca é o campo "Buscar" de pessoas em Seguindo (sem aba, ícone ou tela de busca; a barra de abas continua com cinco abas). A lista Avisos dentro do app (quem começou a seguir você, com "Seguir de volta") é o único aviso e não é uma notificação do sistema. As ações numa publicação são responder, republicar, citar e curtir (e denunciar; na Espiadinha também seguir); os números de respostas, republicações, citações e curtidas só aparecem quando são conhecidos. A prévia da página segue a mesma regra.
