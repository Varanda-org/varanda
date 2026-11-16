# Sobras de Momentos, Depoimentos, Mural e comunidades, parte 1 (branch fix/mural-leftovers, parte da #447)

A #447 junta os limites que os PRs #424 a #427 e #429 deixaram. Esta parte cuida das telas. A parte 2 leva os momentos vistos para o documento de vistos (por identidade, sincronizado entre aparelhos) e fecha a issue.

## O que muda

- **Barra do perfil meio apagada (#424).** Quando a rolagem para dentro da faixa em que a barra aparece, a lista desliza até a ponta mais próxima da faixa: a barra fica toda escondida ou toda visível. Com o dedo na tela nada desliza; depois de soltar, o deslize espera a rolagem parar (160 ms sem quadros), inclusive o embalo. Na web, uma rolagem de roda que para dentro da faixa também desliza. Lógica pura em `profileBarSnap` e `profileBarRestPlan` (`apps/app/src/profileBar.js`).
- **Títulos cortados (#425).** O nome de uma comunidade na lista de Comunidades usa até duas linhas.
- **"Retirar" com depoimento duplicado (#426).** Com mais de um bloco próprio para a mesma pessoa, "Retirar" mira o mais novo (o maior `wseq` dos mostrados e `seq` dos pendentes), não o primeiro que o semeador listou. O nó continua conferindo `about`.
- **`testimonial.pending` que falha em silêncio (#426).** Na aba Depoimentos do próprio perfil, uma falha dessa leitura (por exemplo sem a chave de mensagens) aparece com o texto do erro e "Tentar de novo".
- **Linha "Enviados" (#426).** Só aparece quando há depoimento enviado e abre a tela de Depoimentos já na seção Enviados. Para saber se há, o perfil lê o próprio diário página a página até achar o primeiro enviado, no máximo as mesmas 8 páginas que a tela lê antes de "Ver mais". Quem nunca enviou paga essas leituras locais a cada atualização do perfil. Na web, as tentativas de `scrollToIndex` podiam acabar antes de o react-native-web medir as linhas; a tela tenta de novo a cada mudança de tamanho do conteúdo, até a pessoa rolar.
- **Abas na web com 320 px ou menos (#426).** `Segmented` mede a própria largura; abaixo de 112 px por aba, o recuo lateral cai de 8 para 2 e a letra de 15 para 13, e os rótulos cabem. Só na web: no celular o texto já encolhe para caber (`adjustsFontSizeToFit`, que o react-native-web ignora), então as abas da Feira, com quatro, continuam como antes num celular.
- **Seletor de fotos do momento (#427).** O momento guarda uma foto, então o seletor pede uma só ao sistema (`pickImage`); na web abre o seletor de um arquivo. Antes ele deixava escolher várias e descartava as outras sem avisar.
- **"Novo momento" e "Publicar como" (#427).** O compositor do momento continua abrindo como a pessoa (o momento é dela). Ao fechar, publicado ou cancelado, a Página que estava escolhida volta, a menos que a pessoa tenha escolhido outra identidade nesse meio tempo. Uma conta nova esquece a Página guardada.
- **Autor desconhecido sem nome (#429).** Quando o semeador dá a dica de Página para um autor sem nome nem @nome, o cache de nomes guarda esse autor como Página (`pageOnlyEntry`), e a ação de conversa privada some sem esperar o nome. A conferência no toque continua valendo. O limite correspondente saiu da seção 139 de `docs/verification.md`.

## Decidido pelo dono do produto na #447

Sem código, registrado aqui:

- Os momentos próprios continuam entrando na fila de momentos dos outros.
- Cancelar o compositor do momento mantém o rascunho.
- A foto do momento continua com `contain` (sem corte).
- A lista de Membros continua só para criador e administradores (seção 121 de `docs/verification.md`, atualizada).
- O chip de contexto da conversa continua quebrando em até duas linhas.
- A contagem de membros na busca de grupos (e na lista de grupos de uma comunidade) continua vindo do índice do semeador: conta os diários que entraram e não saíram, inclusive quem foi banido e quem espera aprovação. O cabeçalho do grupo conta só os membros, pela dobra completa. Os dois números coincidem num grupo aberto sem banimentos.

Já resolvidos na `main` antes desta branch: abas do perfil fixas (`ProfileBar`), o mesmo estilo de aba da Busca (`Segmented`), a conversa com uma Página que não enviava (#429) e o "Agora não" dos depoimentos, que virou decisão guardada no nó, por identidade (#610).

## Testes

Cada arquivo rodou sozinho (`node apps/app/test/<arquivo>`) nesta branch e, com os mesmos testes, sobre as fontes do app na `main` (extraídas com `git archive` numa pasta temporária).

| Arquivo | Branch | Fontes da `main` |
|---|---|---|
| `profileBar.test.js` | 16/16, 333/333 | quebra (`profileBarSnap is not a function`) |
| `segmentedFit.test.js` | 2/2, 9/9 | não carrega (`segmentedFit.js` não existe) |
| `comunidadesRow.test.js` | 1/1, 2/2 | 0/1, 0/2 |
| `pickLimit.test.js` | 3/3, 7/7 | não carrega (`pickLimit.js` não existe) |
| `actingAs.test.js` | 11/11, 46/46 | quebra (`enterMoment is not a function`) |
| `namesCache.test.js` | 14/14, 96/96 | quebra (`pageOnlyEntry is not a function`) |
| `depoimentos.test.js` | 33/33, 290/290 | 2 falhas, depois quebra |
| `nav.test.js` | 27/27, 512/512 | 26/27, 511/512 |
| `testimonials.test.js` | 10/10, 47/47 | 10/10, 47/47 (sem mudança) |

Também passam, sem mudança: `profilePolish`, `platformGate`, `perfScroll`, `muralScreen`, `embedLayer`, `moments`, `videoCompose`.

O deslize da barra (timer e estado do dedo) não tem teste automático; os testes cobrem as funções puras, e o comportamento foi conferido nos aparelhos abaixo.

## Conferência em aparelho

Build de debug com a Vitrine (`EXPO_PUBLIC_VARANDA_VITRINE=1`) servida pelo Metro desta branch.

| Item | Android (emulador, API 36) | iOS (simulador, iPhone 17 Pro) | Web (painel do navegador, 320 px) |
|---|---|---|---|
| Barra do perfil | arrastar devagar e soltar dentro da faixa: desliza até a ponta mais próxima; com o dedo parado na tela, nada desliza | desliza nas duas pontas | não conferido |
| Linha "Enviados" | abre Depoimentos no fim da lista, com "Enviados" à vista (conferido de novo depois da nova tentativa da web) | idem (antes da nova tentativa da web) | idem: `scrollTop` 386 de 386, título dentro da lista |
| Seletor do momento | o seletor do sistema pede uma foto só | PHPicker de uma foto | não conferido |
| Abas `Segmented` | sem mudança (o texto encolhe sozinho) | sem mudança (idem) | Feira com 80 px por aba e abas do Diário com 107 px: letra 13, rótulos cabem, sem estouro |
| Comunidades | não conferido | lista aparece como antes | não conferido |

Limites:

- A lista inteira de Depoimentos da Vitrine cabe quase toda na tela: a rolagem para no fim e o título "Enviados" não chega ao topo.
- Na web, só o toque informa que há um dedo na lista. Com o mouse segurando a barra de rolagem parada dentro da faixa, a barra do perfil desliza depois de 160 ms.
- A volta da Página escolhida ao fechar o momento não se confere na Vitrine, que não tem Página; o teste `actingAs.test.js` cobre o caso.
- Os nomes de comunidade da Vitrine cabem numa linha, então a quebra em duas linhas não apareceu nos aparelhos; `comunidadesRow.test.js` confere o `numberOfLines`.
