# O aplicativo Varanda

O app é a interface do Varanda para iOS, Android e web. Ele não guarda lógica de protocolo: fala com um nó pelo contrato de [rpc.md](rpc.md). A interface ainda está em construção. Onde este documento diz "em construção", a tela pode mudar de campos ou de ordem.

## O que o app faz hoje

- Cria a identidade (a chave pública do diário; na web, derivada de uma passkey) e mostra o estado do certificado de membro.
- Publica textos e respostas no diário da pessoa, e define nome e bio.
- Segue e deixa de seguir chaves públicas.
- Mostra o feed dos diários seguidos e o diário da própria pessoa.
- Sincroniza com pares e com o semeador, uma vez ou de modo contínuo.

Os formatos de registro e de certificado estão em [protocol.md](protocol.md). Os nomes das partes do app (A Rua, Diário e os demais) vêm de [design.md](design.md).

## Onde o nó roda

Há três jeitos de ter um nó, e a interface é a mesma:

- **No aplicativo (iOS, Android).** O nó é a sessão do `@varanda/core` rodando num worklet Bare dentro do app. A interface fala com ele por IPC, sem token: o canal é privado do processo do app. Os dados ficam no diretório de documentos do app, na pasta `varanda`. A prova no simulador iOS está em [ios-gate.md](ios-gate.md). Android ainda não foi verificado em execução nativa.
- **Na web, no próprio navegador.** O nó roda na página: é a sessão do `@varanda/web-member` (Hypercore 10), carregada como o script `varanda-node.js`, servido ao lado do app. Os diários (o próprio e os seguidos) ficam no IndexedDB do navegador (banco `varanda-node`); a chave do diário não fica em lugar nenhum: ela é derivada da passkey a cada entrada (veja "Entrar com a passkey"). O nó não usa a DHT: o único par é o semeador da associação, alcançado pela entrada WebSocket dele (`seed --ws-port`). A interface fala com o nó em memória, sem rede e sem token, com as mesmas mensagens de [rpc.md](rpc.md). É o modo padrão da versão web.
- **Na web, com o `varanda-serve`.** O navegador não roda o nó. Quem roda é o `varanda-serve`, na máquina da pessoa, e a interface fala com ele por um WebSocket em `127.0.0.1`. As chaves ficam na máquina, não no navegador. As opções e as regras de segurança do servidor estão no [README](../README.md) (seção "Servidor local para a interface web"). A página entra nesse modo quando é aberta no endereço que o `varanda-serve` imprime (com `#token=...`); a aba lembra o modo até ser fechada.

## Primeira configuração

### No app nativo: tela Conectar

No app nativo, a tela pede:

- a chave pública da associação (64 dígitos hexadecimais);
- como achar pares: uma lista de bootstrap (`host:porta`) ou o interruptor "DHT pública", que começa desligado;
- opcionalmente, o endereço local da DHT.

Com a DHT pública ligada, o endereço local da DHT não pode ser de loopback (`127.x.x.x`, `localhost`, `::1`): uma DHT presa ao próprio aparelho nunca alcança um par público. O formulário recusa com "com a DHT pública, apague o endereço local da DHT: ... só alcança este aparelho", e o nó recusa a mesma combinação. Uma configuração gravada antes dessa regra perde só esse endereço quando o app a lê.

A DHT pública é uma escolha ativa da pessoa (opt-in). Sem bootstrap e sem o interruptor ligado, o nó não tem como achar pares. A configuração, que não é segredo, fica em `Documents/varanda-config.json`, fora do diretório de dados do nó, e só é gravada depois que o nó inicia com ela. Ajustes › Conexão mostra a mesma configuração depois: dá para trocar o bootstrap ou a DHT pública (o nó reinicia), mas a associação fica só para leitura depois que a identidade existe.

Depois do Conectar (ou, com o `varanda-serve`, logo de início), a etapa Identidade aparece sozinha, sem as abas, até a identidade existir e o certificado estar gravado. Nela, um link "Conexão" abre Ajustes › Conexão.

### Na web, com o nó no navegador: Entrar

**Primeira visita numa instalação hospedada.** A página busca `/varanda.json` na própria origem (`{"v":1,"association":"<chave>"}`), monta sozinha a configuração (a associação e o semeador `wss://<este host>/seeder`) e mostra só o botão **Entrar**. Ninguém preenche a tela Conectar. Se o `/varanda.json` falha numa página hospedada, o app mostra o erro com "tentar de novo"; o formulário manual só aparece se a pessoa pedir ("configurar manualmente").

**Entrar com a passkey.** A identidade não é guardada: é derivada de uma passkey (WebAuthn com a extensão PRF), de preferência guardada no Gerenciador de Senhas do Google, que a sincroniza entre os aparelhos da mesma conta. Na primeira vez, "criar passkey" cria a passkey (rotulada `Varanda xxxxxx`, sem e-mail nem identificador do Google) e deriva a chave; nas seguintes, "entrar com a passkey" pede biometria ou PIN e deriva a mesma chave. A chave só existe na memória da página enquanto ela está aberta: ao recarregar, a página volta a Entrar. Algumas passkeys só entregam o resultado PRF num segundo passo, e então a página pede "concluir a criação da passkey".

O que a pessoa precisa saber (a tela diz o essencial):

- **Perder a passkey é perder a identidade.** Não há arquivo de recuperação nem exportação da chave. Limpar os dados do site não perde nada: a mesma passkey deriva a mesma chave, e o diário e o certificado voltam do semeador (a linha "certificado recuperado do semeador").
- **Uma passkey, uma identidade.** O sistema pode oferecer outro gerenciador de passkeys (um iPhone usa as Chaves do iCloud): essa é outra passkey, portanto outra identidade, que precisa de um certificado novo. Se o diário guardado no navegador é de outra identidade, a página diz isso e oferece "recomeçar com esta passkey" (apaga o diário daqui; o do semeador continua sendo da chave antiga).
- **Navegador sem PRF.** Sem a extensão PRF não há identidade e não há alternativa. A página explica e sugere o Chrome ou o Edge com o Gerenciador de Senhas do Google, ou o Safari 18 com as Chaves do iCloud. Se uma passkey foi criada mas não serve, a página diz qual apagar do gerenciador ("Apague do gerenciador de senhas a passkey "Varanda xxxxxx"") e não a oferece de novo.
- **Diário de antes das passkeys.** Um diário antigo (com a chave gravada no navegador) não pode ser aberto nem reconstruído. Na primeira abertura, o nó apaga sozinho a chave antiga gravada no navegador (o diário continua legível, nunca mais gravável); a página oferece "apagar o diário e recomeçar" e, depois, a identidade nova precisa de um certificado novo.
- **Ajustes** tem "bloquear identidade" (na lista da folha, na web com o nó no navegador): apaga a chave da memória e volta a Entrar (os diários continuam legíveis).

**Sincronização ao publicar.** Para não bifurcar o diário, antes de cada escrita (publicar, responder, perfil, certificado) o nó alcança o semeador e, depois dela, a envia. As linhas de Ajustes › Sincronizar mostram isso: "sincronizando antes de publicar", "enviando ao semeador", "diário próprio sincronizado (N)" ou "diário próprio atrasado (N/M)". Se o semeador não responde em 15 s, a publicação não é feita. Limite conhecido: dois aparelhos que publicam ao mesmo tempo (em poucos segundos), ou um aparelho sem conexão, ainda podem bifurcar o diário, e o semeador apaga um diário bifurcado.

**Conectar (uso avançado e desenvolvimento).** Fora de uma instalação hospedada (por exemplo `localhost`), ou quando não há `/varanda.json`, a tela Conectar da web continua pedindo:

- a chave pública da associação (64 dígitos hexadecimais);
- o endereço do semeador: `ws://` ou `wss://`, com servidor, porta e caminho opcionais (por exemplo `wss://semeador.exemplo/seeder`), sem usuário, consulta nem fragmento. Numa página `https`, só `wss://` (o navegador recusa `ws://` ali).

O nó confere o semeador pelo certificado que a associação assinou para ele, como a CLI faz; a chave do semeador não é pedida. Um endereço que responde sem esse certificado não recebe nada: a sincronização mostra "peer seeder <chave8> não verificado" e o aviso "o endereço configurado não respondeu como um semeador verificado".

A configuração, que não é segredo, fica no `localStorage` (`varanda-web-config`) e só é gravada depois que o nó abre com ela. Ajustes › Conexão mostra o estado ("o nó roda neste navegador"), a associação e o endereço do semeador; dá para trocar o endereço ("aplicar e reconectar" fecha o nó e o abre de novo), e a associação fica só para leitura depois que a identidade existe.

Uma aba por navegador: o nó guarda o diário no IndexedDB e duas abas gravando nele estragariam o diário. A primeira aba fica com o nó (Web Lock `varanda-node`); outra aba mostra "outra aba já usa o Varanda neste navegador". Num navegador sem a API Web Locks, não há essa proteção.

Limites desta versão (detalhes em [verification.md](verification.md), seção 10):

- Quem serve a página pode trocar o código dela, e a chave está na memória da página enquanto a identidade está desbloqueada.
- A passkey vale para o endereço exato da página (`rp.id` é o host): mudar de endereço depois exige trabalho extra.
- Cada arquivo de um diário aberto fica inteiro na memória da aba enquanto está aberto (as gravações no IndexedDB são por página de 16 KiB, não o arquivo inteiro).

### Na web, com o `varanda-serve`: sem Conectar

Com o `varanda-serve` não há tela Conectar, mas há a mesma etapa Identidade e certificado. A associação, o bootstrap e a DHT vêm das opções do `varanda-serve`. O token chega no fragmento da URL (`#token=...`) que o `varanda-serve` imprime. O app o lê uma vez, tira o fragmento da barra de endereço (`history.replaceState`), o guarda só em memória (nem `localStorage`, nem cookie) e o envia em `session.open`; no `sessionStorage` fica só a marca de que a aba usa o `varanda-serve`, nunca o token. O navegador não envia o fragmento ao servidor. A página só conecta se foi aberta em `127.0.0.1` ou `localhost`. Ela não reconecta sozinha: Ajustes › Conexão tem o botão "reconectar". Se outra aba abrir a sessão, esta mostra "outra aba assumiu a conexão".

## Telas

Os nomes estão fixos; os detalhes visuais ainda mudam. O desenho (cores, tamanhos, componentes) está em [app-design.md](../apps/site/artwork/app-design.md); as funções e o protocolo são os mesmos de antes.

O app tem três abas na barra de baixo: **A Rua**, **Seguindo** e **Diário** (abre em A Rua). Um botão verde, "publicar", abre a folha de Publicar por cima de qualquer aba. Os ajustes ficam numa folha aberta pela engrenagem do cabeçalho do Diário. No app nativo e na web com o nó no navegador, a primeira configuração acontece antes das abas (veja "Primeira configuração"); na web hospedada, é só Entrar.

- **Barra do topo (A Rua e Seguindo).** A cadeira, o título e o chip de sincronia, que mostra o estado em uma palavra: "sem conexão", "sincronizando…", "sincronizado agora" (ou "sincronizado há N min") depois de uma rodada que terminou por `done` e sem `result.ok` falso, ou "sincronizar" quando não há rodada concluída. O chip sempre abre Ajustes › Sincronizar, que oferece "abrir Conexão" quando não há conexão. Não há faixa de conexão sobre a linha do tempo: o estado fica só no chip e em Ajustes › Conexão.
- **A Rua.** O feed, da mais nova para a mais antiga, numa linha do tempo contínua. Cada publicação tem avatar com as duas iniciais do nome (a cor vem do primeiro byte da chave, módulo 5: azul, laranja, amarelo, vermelho, verde), o nome em negrito (sem nome, o handle: `@` e os seis primeiros dígitos hexadecimais da chave), o tempo relativo ("agora", "5 min", "1 h", "ontem", "12 out") e uma única ação, "responder". Uma resposta mostra "respondendo a Nome": o nome vem do perfil do diário seguido, ou o handle se não houver. Abre com 30 publicações; ao rolar até o fim chega ao máximo de 35 (`FEED_LIMIT_MAX`, em [rpc.md](rpc.md)) e depois avisa que as mais antigas não estão disponíveis nesta versão. Puxar para baixo recarrega (no app nativo; na web, o botão "atualizar"). A lista recarrega sozinha quando uma rodada de sincronização termina (menos quando foi interrompida por outro pedido) e depois de publicar; os avisos de itens ignorados ou com data futura continuam. Por ora A Rua mostra só os diários seguidos; trazer quem a pessoa não segue é uma mudança de desenho descrita em [design.md](design.md).
- **Publicar.** Folha com "Cancelar", a pílula "Publicar" (desligada com o texto vazio ou acima de 1000 pontos de código), o avatar da própria pessoa, o campo "O que está rolando na varanda?", um anel de progresso e o contador "N/1000" (vermelho em 1000). Responder usa a mesma folha, com "respondendo a Nome" e "cancelar resposta". O rascunho sobrevive ao fechar a folha e a qualquer falha; um pedido incerto nunca é reenviado.
- **Seguindo.** No topo, o campo da chave e a pílula "Seguir". Cada linha tem avatar, nome, handle (tocar mostra a chave inteira) e a pílula "Seguindo", que deixa de seguir e lê a lista de novo. A lista é paginada.
- **Diário.** O perfil e o diário da própria pessoa. Uma faixa em gradiente passa por trás da barra de estado, com a engrenagem dos ajustes; embaixo, avatar de 88 pt, o botão "Editar perfil", o nome, o handle (tocar mostra a chave inteira), a bio e "N seguindo" (não há seguidores). Falta o certificado? Uma linha de aviso diz isso. Em "PUBLICAÇÕES" ficam as publicações da pessoa no estilo da linha do tempo, só a página mais recente; perfil, certificado e blocos inválidos aparecem como linhas técnicas discretas ("bloco inválido (#seq: motivo)").
- **Editar perfil.** Folha com nome (1 a 80 caracteres) e bio (0 a 280), preenchida com o registro de perfil mais novo entre os 42 blocos mais novos do próprio diário; "Cancelar" descarta.
- **Ajustes.** Folha com três itens, sem mudança de função:
  - **Conexão.** No app nativo e na web com o nó no navegador, a configuração da tela Conectar; com o `varanda-serve`, o estado da conexão com ele e o botão "reconectar".
  - **Sincronizar.** Sincroniza uma vez ou de modo contínuo, para a sincronização e mostra as últimas 200 linhas de evento.
  - **Identidade.** Cria a identidade e mostra a chave pública e o estado do certificado de membro. Aceita colar o JSON do certificado emitido pela associação.
  - Na web com o nó no navegador, a folha também tem "bloquear identidade".

Na web, as folhas fecham com Escape.

### Nomes

O RPC não tem um método que troque chave por nome. O app guarda um cache de nomes por sessão: aprende com o feed (cada item traz o nome atual do autor) e, para cada chave desconhecida em Seguindo, nas marcas de resposta e para a própria chave (o avatar de Publicar), faz um `log.read { author }`, um de cada vez, parado durante uma sincronização (um pedido de membro interrompe a rodada) e repetido quando uma rodada termina. Enquanto uma sincronização roda (por exemplo com "sincronizar sempre"), as buscas de nome ficam paradas: as linhas de Seguindo e as marcas de "respondendo a" mostram o handle (@ mais 6 dígitos hexadecimais) de quem o feed ainda não nomeou, até a sincronização parar. Dois limites:

- `log.read { author }` devolve só os 42 blocos mais novos do diário ([rpc.md](rpc.md), 5.12). Quem seguiu alguém cujo registro de perfil é mais antigo que isso vê o handle nas linhas de Seguindo e nas marcas de resposta, a menos que o feed, que lê o diário inteiro, já tenha dado o nome.
- Um nome aprendido vale a sessão toda. Se uma pessoa seguida muda o perfil e não tem publicações no feed, o app mantém o nome antigo até ser reiniciado (quem tem publicações é atualizado pelo feed).

Todo nome, como todo texto de outros pares, passa por `displayText`.

### Navegação

Onde ficou cada uma das oito telas de antes:

| Tela de antes | Onde fica |
|---|---|
| A Rua | aba A Rua |
| Seguindo | aba Seguindo |
| Diário | aba Diário (o perfil em cima, as publicações embaixo) |
| Perfil | Diário › Editar perfil |
| Publicar | botão "publicar" (folha); "responder" em qualquer publicação |
| Sincronizar | Ajustes › Sincronizar (o chip de sincronia abre a mesma tela) |
| Conexão | Ajustes › Conexão (no app nativo, também a tela Conectar da primeira vez) |
| Identidade | Ajustes › Identidade (na primeira configuração, a etapa Identidade) |

Um pedido que muda algo e fica sem resposta (tempo esgotado ou conexão perdida) aparece como "incerto: pode ter sido aplicado; confira antes de repetir". O app nunca reenvia esse pedido sozinho. Antes de oferecer a ação de novo, ele lê o estado outra vez. Publicar relê o próprio diário: se a publicação está lá (mesmo texto e mesma resposta, criada por este envio), conta como publicada, limpa o rascunho e fecha a folha; senão o rascunho fica, com a mensagem "incerto: pode ter sido aplicado; confira antes de repetir". Editar perfil faz a mesma conferência no registro de perfil mais novo. Seguindo relê a lista depois de qualquer falha ao seguir ou deixar de seguir.

Só um nó usa um diretório de dados por vez: um segundo worklet no mesmo diretório recebe `LOCKED`. Na web com o nó no navegador, só uma aba por navegador abre o nó (veja "Na web, com o nó no navegador: Entrar"). Todo texto vindo de outros pares passa por `displayText`, do `@varanda/rpc`, antes de aparecer.

## Fora do piloto

- **Cadeiras de Praia:** conversas em grupo e salas de áudio. Pedem diário com vários autores e transmissão em tempo real.
- **Espiadinha:** a aba de descobrir. Pede a cidade ou o estado de quem publica.
- **Selo Gente da Gente:** pede critério para "construtivo" e quem concede.

Os pontos em aberto de cada um estão em [design.md](design.md).
