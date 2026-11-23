# Rolagem da conversa privada na web (branch fix/web-chat-scroll)

Na web e no PWA, a conversa privada (`Mensagem.js`) pulava:

- **Ao abrir:** a `FlatList` desenhava as linhas em lotes de 8. Cada lote aumentava a altura, a tela chamava `scrollToEnd` de novo, e o `scrollToEnd` do react-native-web caía numa posição estimada antes de as linhas serem medidas.
- **Ao carregar mensagens anteriores:** a página antiga entra no começo da lista e a tela voltava uma página inteira, porque o react-native-web 0.21 ignora `maintainVisibleContentPosition`.

No celular nativo isso já não acontecia, e nada muda lá. A conversa do grupo (`Grupo.js`) tem o mesmo problema e fica para outra branch (veja "Grupos" abaixo).

## O que muda

- **`RefreshableList` ganha a opção `allRowsOnWeb`**, que só vale na web. Só a conversa privada a liga; o grupo, A Rua, Diário, Seguindo e as outras listas não mudam.
- **Com a opção ligada, a lista desenha de uma vez todas as mensagens já carregadas.** Assim, a abertura vai direto ao fim.
- **O `scrollToEnd` dessa lista usa a altura real do DOM**, via `scrollToOffset`, em vez da estimativa. O `scrollTo` do nó de rolagem é o do react-native-web (`{ x, y }`): um `scrollTo({ top })` no estilo do DOM ia para o topo.
- **Quando uma página anterior chega na frente da lista, com `keepVisiblePosition` ligado, o `WebAnchor` mantém a mensagem que está sendo lida no lugar.**
  - Antes da mudança no DOM (`getSnapshotBeforeUpdate`), ele guarda a borda de baixo da primeira linha visível.
  - Depois dela (`componentDidUpdate`), ele corrige `scrollTop` pela diferença.
  - Vale a borda de baixo porque, quando a página antiga chega, a primeira mensagem antiga perde o separador de dia no alto dela (o separador passa para a página antiga).
  - Ele só age quando a antiga primeira linha continua na lista, mais abaixo (`isPrepend`, pela chave da linha). Uma mensagem enviada, uma reação ou outra mudança de dados fica com a ancoragem do navegador.
  - Ele não age quando todas as linhas cabem na tela: aí não há posição de leitura, e a página anterior aparece acima delas, como no nativo.
- **A ancoragem de rolagem do próprio navegador continua ligada.** Ela cuida das linhas acima da leitura que mudam de altura depois de montadas, como um player que se mede depois. Ela não cuida da página anterior, porque o navegador não ancora com a lista no topo (`scrollTop` 0), que é onde a página anterior chega.
- **Funções puras em `apps/app/src/webAnchor.js`:** `pickAnchor` escolhe a linha, `anchorShift` calcula a diferença e `isPrepend` reconhece a página anterior.

**Diferença do nativo:** no nativo, com a lista a menos de 24 px do topo (`autoscrollToTopThreshold`), a página anterior que chega fica à vista. Na web, numa conversa longa, a mensagem lida fica no lugar e a página anterior fica acima dela, também quando a pessoa toca em "mensagens anteriores" já no topo. Basta rolar para cima para vê-la.

## Medição

Feita no Chrome sem interface, a 375 × 812 px (densidade 2), controlado pelo protocolo de depuração (CDP), na Vitrine (`EXPO_PUBLIC_VARANDA_VITRINE=1`).

- **Dados extras:** uma linha local e temporária (fora do commit) pôs 80 mensagens antigas na conversa com Bia Araújo e 60 no grupo "Passeios de bicicleta".
- **Amostragem:** a cada quadro de animação, o script registrou `scrollTop`, `scrollHeight`, o texto em y = 300 e as primeiras linhas visíveis.
- **Rolagem:** a rolagem para cima usou eventos reais de roda do mouse.

| | Antes | Depois |
|---|---|---|
| Abrir a conversa privada | 7 mudanças de posição depois do primeiro quadro rolado, até chegar a 1982 | 0 mudanças: o primeiro quadro já está no fim (1982 de 1982) |
| Página anterior chegando (conversa privada) | "antiga 57" em y = 300 vira "antiga 29": uma página para trás | A altura cresce 2299 px (2664 para 4963) e `scrollTop` sobe os mesmos 2299 (0 para 2299): "antiga 57" fica no mesmo lugar |
| Abrir o grupo | 5 mudanças, parando em 1732 de 1740 (8 px antes do fim) | Igual: o grupo não muda nesta branch |

**A primeira tentativa** guardava a borda de cima da linha e deixou um erro de 34 px. A linha "antiga 56" continuava em 68 px, mas perdia o separador "3 nov" e caía de 78 para 44 px de altura. Com a borda de baixo, o erro some.

**Linha acima da leitura que cresce depois:** o script aumentou em 120 px uma linha já acima da tela, como faz um player que se mede depois de montado.

- Com `overflow-anchor: none`, que uma versão anterior desta branch usava, o texto descia: "antiga 57" virava "antiga 56".
- Com a ancoragem do navegador ligada, `scrollTop` sobe 120 (2299 para 2419), e "antiga 57" fica no lugar.
- A página anterior continua estável nos dois casos: o navegador não soma uma segunda correção.

**Conferências na mesma sessão, sem exceção nem erro no console:**

- **Enviar:** a mensagem enviada segue o fim (2026 de 2026, e a última linha é a enviada).
- **Botão "ir para o fim":** depois de rolar 1250 px para cima o botão aparece, e o toque leva a 2026 de 2026.

**Custo de digitar com todas as linhas desenhadas** (mediana do tempo de uma tecla no campo de mensagem, com 300 mensagens antigas na linha temporária, Chrome do computador sem limitação de CPU):

- Conversa privada: 20 ms com as 33 linhas da abertura, 34 ms depois de carregar todas as páginas (307 linhas). As linhas são `MessageRow`, memorizadas, e não se redesenham a cada tecla.

**Conferência ao contrário:**

- Com a correção do `WebAnchor` desligada (todas as linhas ainda desenhadas e a ancoragem do navegador ligada), a página anterior volta a pular ("antiga 57" vira "antiga 29").
- Com `allRowsOnWeb` desligado, a abertura volta a pular (7 mudanças na conversa privada).

## Grupos

O grupo chegou a ligar `allRowsOnWeb` nesta branch, e a abertura e a página anterior ficaram estáveis lá também (0 mudanças, 1740 de 1740). Mas cada tecla no campo redesenha todas as linhas montadas: o corpo da linha do grupo é uma função dentro de `renderItem`, sem memorização, e `extraData` é um objeto novo a cada render. Com 309 linhas montadas, a mediana de uma tecla foi 149 ms (p90 perto de 220 ms), contra 23 ms com a lista em janelas (41 linhas). Por isso o grupo fica como está, e a correção dele vem depois de as linhas do grupo ganharem uma linha memorizada como a `MessageRow`.

## Testes

- `node apps/app/test/webAnchor.test.js`: 11 testes, 28 asserções.
  - A escolha da linha: linha meio escondida, linhas acima da tela, lista vazia, valores inválidos.
  - A diferença, com o caso de menos de meio pixel.
  - `isPrepend`: página anterior na frente é reconhecida; mensagem nova no fim, mesmos dados, primeira carga, lista trocada ou esvaziada, dados nulos e linha sem chave não são.
  - Uma leitura do código que exige `allRowsOnWeb` na lista da conversa privada, o `getSnapshotBeforeUpdate` e o import em `RefreshableList.js`, e nenhum `overflowAnchor` nele.
- Uma reação numa mensagem não foi medida no navegador; o caso fica coberto pelo teste de `isPrepend` (mesma lista, mesmas chaves, sem correção).
- **Na entrega:**
  - lint;
  - os arquivos de teste do app que importam ou leem `RefreshableList`, `webAnchor` ou uma tela que usa a lista;
  - `npm run demo`.
- O conjunto completo roda na CI do PR.

## Fora desta branch

- **Grupos:** veja a seção acima.
- **Aparelhos de verdade:** não foram usados. Falta conferir a abertura e a página anterior da conversa privada:
  - no PWA do iPhone (Safari);
  - no Chrome do Android;
  - no Safari e no Firefox do computador.
- **Navegador sem ancoragem de rolagem:** a correção de uma linha que cresce depois depende do navegador. Não conferi se o Safari do iPhone faz essa ancoragem; se não fizer, uma linha acima da leitura que cresce depois ainda desloca o texto, como antes desta branch.
- **Histórico longo:** na web, a conversa privada agora mantém no DOM todas as mensagens já carregadas. O número cresce só com as páginas que a pessoa carrega rolando para cima. Uma conversa com milhares de mensagens carregadas não foi medida.
- **Celular nativo:** continua com `maintainVisibleContentPosition` e com os lotes de antes.
