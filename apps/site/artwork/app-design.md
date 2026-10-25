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
| verde | `#1d6b4f` | ação: botão de publicar, pílula Publicar, aba ativa, chip de sincronia, nome em "respondendo a", cursor |
| verde claro | `rgba(29,107,79,0.10)` | fundo do chip de sincronia |
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
| chip de sincronia | 12 | 600 | 1 |
| rótulo de aba | 10 | 600 | 1 |
| contador | 13 | 600 | 1 |
| cabeçalho de seção ("PUBLICAÇÕES") | 13, caixa alta, +0,04 em | 700 | 1 |
| iniciais do avatar | 16 (44 pt), 30 (88 pt) | 700 | 1 |

Cantos arredondados, botões em pílula, entrelinha generosa, nomes em negrito.

## Componentes

- **Barra do topo** (52 pt, fio embaixo): a cadeira (`cadeira.svg`, 32 pt) à esquerda, o título, e à direita o **chip de sincronia** (pílula verde clara, ícone de setas) com os estados "sem rede", "sem conexão", "recuperando…", "sincronizando…", "sincronização automática", "reconectando…", "conectando…" e "pausado"; não há "em dia" nem hora da última sincronia. Tocar no chip abre Ajustes › Sincronização.
- **Linha de publicação** (`.post`): avatar 44 pt, 12 pt de vão, nome em negrito + `@nome · tempo` na mesma linha (a linha não quebra; o tempo some com reticências se faltar espaço). O negrito é sempre o nome livre do perfil (sem `@` no começo, nem os parecidos) ou, sem nome, o `@nome` escrito como nome (`ana`); o `@nome` em texto suave só aparece quando vem de um registro verificado, então um nome livre como "@ana" nunca se passa pelo `@nome` verificado de outra pessoa. Sem `@nome` verificado, só o tempo; sem nome nem `@nome`, "sem nome" em negrito e o tempo, texto, e **uma ação**: responder (balão de fala, 19 pt, texto suave, sem número). Preenchimento 12/16/10 pt, divisória de 1 pt entre linhas. **Sem cartões**: a linha do tempo é contínua, como no X e no Threads.
- **Marca de resposta**: acima do texto, "respondendo a **Nome**" em 13 pt, o nome em verde. O nome vem do perfil do diário; sem perfil, o `@nome` ou "sem nome" (enquanto o autor não foi consultado, "…"). Nunca a chave.
- **Avatar**: círculo com as duas iniciais do nome ou, sem nome, do `@nome` (primeira letra do primeiro e do último nome); sem nenhum dos dois, um glifo de pessoa, nunca caracteres da chave. A cor continua vindo da chave pública: `primeiro byte mod 5` escolhe nas listras, na ordem azul `#2a7fb8`, laranja `#e8805a`, amarelo `#f2b705`, vermelho `#e94e3c`, verde `#1d6b4f`. Iniciais brancas no azul, no vermelho e no verde; em tinta no laranja e no amarelo (contraste). Assim, com as chaves da demonstração: Marília Prado (`e9…`) vermelho, Bia Carvalho (`16…`) amarelo, Seu Nelson (`0f…`) azul, Helena Dias (`eb…`) azul.
- **Nome e @nome**: o nome é o do perfil do diário e o `@nome` é o registrado na associação. A chave nunca aparece como texto nas listas; só no próprio perfil, atrás de "mostrar chave", em Ajustes › Identidade e no passo do certificado de membro.
- **Tempo relativo**: "agora", "5 min", "1 h", "ontem", depois a data curta ("12 out").
- **Barra de abas** (83 pt com a área segura, 49 sem): três abas com ícone de linha (27 pt) e rótulo (10 pt): **A Rua** (casa), **Seguindo** (duas pessoas), **Diário** (pessoa). Ativa em verde, traço mais grosso; inativas em texto suave. Fundo creme a 94 % (o conteúdo passa por baixo).
- **Botão de publicar** (`.app__fab`): círculo verde de 56 pt, lápis branco, a 20 pt da direita e 100 pt do fundo, sombra verde. Abre a folha de Publicar.
- **Folha de Publicar** (`.folha`): sobe por cima da tela, que escurece e encolhe um pouco atrás; cantos de 18 pt no topo, fundo branco. Topo de 56 pt: "Cancelar" à esquerda (17 pt), pílula verde **Publicar** à direita (desligada com o texto vazio). Corpo: avatar 40 pt da própria pessoa e a área de texto em 18 pt com o espaço reservado "O que está rolando na varanda?". Embaixo do texto, à direita: anel de progresso (20 pt, verde sobre fio) e o contador `67/1000` (fica vermelho a partir de 1000). Responder usa a mesma folha, com a marca "respondendo a Nome" acima do texto.
- **Cabeçalho do perfil** (`.perfil`): faixa de 150 pt no gradiente fim de tarde, passando por trás da barra de estado (texto branco ali); engrenagem (34 pt, círculo escuro translúcido) no canto inferior direito da faixa. Avatar de 88 pt com anel creme de 4 pt, sobrepondo a faixa pela metade; à direita, na linha do avatar, a pílula de contorno **Editar perfil**. Depois: nome (22), `@nome`, bio, "mostrar chave" / "esconder chave" (com "copiar" onde o navegador oferece área de transferência), "**3** seguindo" (o número de diários seguidos é conhecido localmente; **não** há seguidores). Cabeçalho "PUBLICAÇÕES" e as publicações da pessoa no mesmo estilo da linha do tempo.
- **Seguindo**: lista de linhas com avatar, nome e `@nome` (uma barra de esqueleto enquanto o nome carrega; nunca a chave), e uma pílula "Seguindo" / "Seguir" à direita; o campo para colar uma chave fica no topo; paginação como hoje.
- **Ajustes** (engrenagem): uma lista agrupada com **Conexão**, **Sincronização** e **Identidade**. Sincronização é só leitura: o estado (sincronizando contínua ou única, recuperando, parada), a última parada, "nova tentativa em n s", as últimas linhas do registro e "Atualiza sozinho enquanto o app está aberto e com rede."; não há botão de sincronizar.
- **Puxar para atualizar**: nas listas, no nativo (controle de atualização do sistema) e na web (gesto de puxar, indicador de 36 pt, limiar de 72 px); na web há também a ação "Atualizar" no topo, alcançável pelo teclado.
- **Rolagem infinita**: A Rua carrega 30 e depois páginas de 35, o Diário páginas de 42, Seguindo de 50, sempre por cursor, uma carga por chegada ao fim. Rodapés discretos: "Isso é tudo por enquanto." (A Rua) e "Início do diário." (Diário); uma página que falhou só tenta de novo por ação da pessoa ("tentar de novo" ou "mostrar mais").
- **Pílula de novidades**: "ver novidades", no topo da lista, quando chegaram dados novos; é uma dica, nunca uma contagem, e a lista não recarrega sozinha.
- **Estados vazios**: um ícone de linha, um título e uma frase curta com uma ação quando houver ("A Rua está vazia", "Ainda não chegou nada", "Você ainda não segue ninguém", "Seu diário está vazio"); erro de carregamento com a mensagem e "tentar de novo".
- **Esqueleto de carregamento**: barras suaves no lugar das linhas (e do nome) enquanto carregam, sem rodinha girando.
- **Primeiros passos**: a primeira configuração é um passo a passo com "Passo n de 3". Na web: "Bem-vindo à Varanda", "Sua conta e seu @nome", "Como você quer aparecer"; no nativo e no `varanda-serve`: "Sua identidade", "Certificado de membro", "Como você quer aparecer". O nome e a bio são opcionais ("Pular por enquanto"); ao terminar, "Tudo pronto. Siga pessoas para encher a Rua."
- **Estado de conexão**: só no chip de sincronia e em Ajustes › Conexão e Sincronização; nenhum banner na linha do tempo.
- **Fila de saída**: uma publicação esperando na fila de saída é uma linha no Diário, nunca um cartão em A Rua e nunca um banner.

## Navegação

Três abas + o botão de publicar + os ajustes. Onde fica cada uma das oito telas de hoje:

| Tela de hoje | Onde fica |
|---|---|
| A Rua | aba A Rua |
| Seguindo | aba Seguindo |
| Diário | aba Diário (o perfil em cima, as publicações embaixo) |
| Perfil | aba Diário › Editar perfil |
| Publicar | botão de publicar (folha); responder a partir de qualquer publicação |
| Sincronizar | Ajustes › Sincronização, só leitura (e o chip de sincronia abre a mesma tela) |
| Conexão | Ajustes › Conexão (no app nativo, também a tela Conectar da primeira vez) |
| Identidade | Ajustes › Identidade |

A primeira configuração (Conectar, criar identidade, certificado, nome) é o passo a passo "Primeiros passos", antes das abas aparecerem.

## O que fica de fora, de propósito

Não desenhar, nem como enfeite, nada que o app não faz: curtidas, repostagens, contagens de visualização ou de respostas, fotos, número de seguidores, notificações, mensagens diretas, busca. A única ação numa publicação é responder. A prévia da página segue a mesma regra.
