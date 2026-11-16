# Sobras do vídeo curto (branch fix/short-video-leftovers, fecha a #536)

A #536 junta os limites que os PRs #495, #496, #497, #506 e #507 deixaram no vídeo curto. Cada item abaixo foi corrigido ou decidido pelo dono do produto, com o motivo.

## O que muda

- **Bloqueio apaga a foto ou o vídeo dos momentos.** Antes, o bloqueio purgava o diário e os núcleos de mídia, mas o blob do momento ficava servido até vencer (7 dias), e quem guardava o descritor podia abri-lo. Agora o drop de um diário bloqueado lê os registros `moment` válidos dos blocos locais e chama `purge(ids)` no conjunto de blobs (`packages/core/lib/blob-pool.js`) ANTES de purgar o núcleo. Vale em tempo de execução (inclusive quando o portão decide outro motivo, como `revoked-issuer`, para uma chave que a lista também bloqueia), no passo 3 da partida e ao desfazer uma admissão que a lista alcançou no meio. `purge` marca os blobs como vencidos (deixam de ser servidos na hora), grava `tokens.json` e remove os diretórios. Uma falha de escrita ou de remoção é uma falha de purga: em tempo de execução, `fatal` com `purge-failed`; na partida, `falha ao limpar diário rejeitado`. O diário continua em `admitted.json` e a próxima partida tenta de novo. Termos e Política na versão 64. Detalhes e riscos residuais em `docs/protocol.md`, seção 13.
- **Android: MP4 órfão no cache.** `stop()` em `VideoPrepModule.kt` resolvia a tarefa (apagando os arquivos) antes de `Transformer.cancel()`, que bloqueia até a thread do Transformer responder; o muxer ainda podia gravar a saída nesse meio tempo, e o arquivo ficava em `<cache>/video-prep/`. Agora os arquivos são apagados de novo depois que `cancel()` volta (`discardUnlessResolved()`).
- **Leitores de tela no vídeo dentro do post.** Na web, o elemento `video` ganhou nome acessível ("vídeo de N segundos", o mesmo rótulo da capa) e `tabIndex` 0 quando tem controles. O foco se perdia: tocar na capa, em "Tentar de novo", em "ver em tela cheia" ou em "fechar" desmonta o próprio botão, e o foco caía no `body`, então o teclado e o leitor de tela voltavam ao topo da página. Agora o player, ao montar, pega o foco só se ele estiver perdido (no `body`), sem rolar a página, e nunca o tira de outro controle. Efeito aceito: com o vídeo em foco, as setas e o Espaço agem no vídeo (volume, posição, pausa), como em qualquer player, e não rolam a lista até o foco sair dele. O player dos momentos não tem controles e não pega foco.
- **Leitores de tela no celular.** A passagem com TalkBack no emulador Android achou três falhas, corrigidas:
  - o vídeo ficava dentro da camada do post escondida dos leitores de tela (`no-hide-descendants`), então nem o deslize nem o toque chegavam à capa ou aos controles. Agora o vídeo fica fora dela, como o player do YouTube já ficava (`videoOut` em `PostRow.js`). A legenda abaixo dele é só para quem vê, porque o rótulo do post já a lê;
  - no Android, uma `View` com `pointerEvents='none'` dentro do botão da capa conta como tocada sem mandar o evento de hover, e a exploração por toque do TalkBack não achava nada na capa. Essas `View`s perderam o `pointerEvents`, e o botão continua recebendo todos os toques (`MediaGrid.js`);
  - tocar na capa, em "Tentar de novo" ou em "fechar" da tela cheia desmonta o botão, e o foco do leitor ia para outro controle. Agora, com leitor de tela ligado, o foco vai para "ver em tela cheia" (ou para "Tentar de novo", se o vídeo falhar) 250 ms depois. Na web isso fica com o player, como acima.

  As fotos continuam dentro da camada escondida: o rótulo do post fala delas, e abrir uma foto em tela cheia pelo leitor de tela fica fora da #536.

## Decidido pelo dono do produto na #536

- **Bloqueio e blobs de momento:** apagar no bloqueio (acima). Depois da revisão, aceito também o risco de abuso: o envio de blobs é anônimo (selos cegos), então o semeador não liga o id ao autor; um diário descartável que copia ids públicos de momentos de outras pessoas e provoca o próprio bloqueio tira esses blobs do semeador antes dos 7 dias. Cada vez custa uma conta verificada e um bloqueio decidido por uma pessoa da moderação, e o momento já some do app em 24 horas. Registrado em `docs/protocol.md`, seção 13, com o reenvio de um blob purgado (quem tem os bytes cifrados e selos válidos pode reenviá-lo; só abre quem já guarda o registro).
- **Limites de plataforma aceitos**, cada um com o motivo:
  - **iOS no simulador cai para 768 px.** É o codificador de software do simulador: a primeira passagem a 960 de um clipe de 60 fps com muito detalhe passa do teto, e a segunda, com lados menores, cabe (seção 183 de `docs/verification.md`). O codificador de um iPhone real é outro; a conferência em aparelho físico fica na #224.
  - **Android: thread presa.** `Transformer.cancel()` bloqueia até a thread do Transformer responder. A tarefa é resolvida antes do `cancel`, então um codec travado custa uma thread, não o módulo, e a próxima preparação não espera por ela. Não há como interromper um codec travado por fora sem matar o processo.
  - **iOS: o prazo é cooperativo.** As bombas de amostras conferem o prazo entre amostras; um `copyNextSampleBuffer` travado não é interrompido, porque `cancelReading` numa thread enquanto outra está dentro dele derruba o AVFoundation. `finishWriting`, a duração e a capa ficam fora do prazo.
  - **Android: duração com 64 ms a mais.** O valor que o módulo informa não é usado: o app lê largura, altura e duração dos bytes depois de `stripVideoMetadata` (`videoPrep.native.js`, coberto por `apps/app/test/videoPrep.test.js`).
  - **iOS: o seletor mostra "Location Is Included".** É o aviso do seletor do sistema sobre o arquivo original, que o app não controla. O app nunca envia esse arquivo: reencoda e remove `udta`, `meta`, `uuid` e localização, e os bytes preparados foram procurados byte a byte (seção 183).
  - **Web: só MP4 H.264 que já caiba.** O navegador não reencoda: isso pediria um codificador em WebAssembly ou WebCodecs, uma dependência grande e com suporte desigual. Um arquivo fora dos limites é recusado com mensagem, sem cortar.

## Testes

Cada arquivo rodou sozinho (`node <arquivo>`) nesta branch. A coluna "sem a correção" é a mesma bateria com a correção retirada à mão.

| Arquivo | Branch | Sem a correção |
|---|---|---|
| `packages/core/test/blob-pool.test.js` (3 testes novos de `purge`) | 27/27 | os 3 quebram (`purge is not a function`) |
| `packages/core/test/blocklist-seeder.test.js` (3 testes novos) | 15/15 | sem a chamada no drop, o teste de tempo de execução e o de motivo trocado falham; sem a do passo 3, a parte da partida falha; sem as duas, o teste de falha fatal não vê `purge-failed` |
| `apps/app/test/hardening.test.js` (descarte depois do `cancel`, mais duas mutações) | 24/24 | falha ("stop discards the files the muxer wrote after the cancel") |
| `apps/app/test/legal.test.js` | 45/45 | versão 64, digest e o texto novo de Termos e Política |
| `apps/site/test/legal.test.js`, `packages/core/test/terms.test.js`, `apps/app/test/terms-version.test.js` | 7/7, 8/8, 1/1 | versão 64 |
| `apps/app/test/videoPlayback.test.js` (nome e foco do player na web) | 22/22 | 21/22 ("a named video takes back lost focus") |
| `apps/app/test/postLayout.test.js` (vídeo fora da camada escondida) | 17/17 | 13/17 |
| `apps/app/test/feedRender.test.js` (capa sem `pointerEvents`, foco do leitor de tela) | 16/16 | com o `pointerEvents` de volta, o teste da capa falha; sem o foco, o teste novo falha |
| `apps/app/test/postOverflow.test.js` (só o recorte do teste, que segue o vídeo) | 15/15 | não se aplica |

O caminho de desfazer uma admissão que a lista alcançou no meio (`seeder.js`, depois de `_blockedReason`) não tem teste próprio: depende de a lista chegar entre a gravação e a abertura do núcleo. A chamada é a mesma dos outros caminhos.

## Conferência em aparelho

Em 2026-11-16, no build de debug com os dados de demonstração (Vitrine) e uma publicação temporária, fora do PR, com um clipe MP4 de 8 s. Ordem: Android, iOS, web.

- **Android** (emulador API 36, TalkBack ligado, sem `uiautomator` rodando, porque ele muda o que o TalkBack acha). O deslize passa por avatar, post (nome e legenda), "vídeo de 8 segundos", "mais ações" e as ações. A exploração por toque acha a capa. Dois toques tocam o vídeo, e o foco vai para "ver em tela cheia". Tocando, chegam o Play/Pause e a barra de tempo do player nativo, "ver em tela cheia" e "Silenciar som". A tela cheia abre com o foco em "fechar", e fechar devolve o foco a "ver em tela cheia". Limite visto, anterior ao PR: o botão "Enter fullscreen" dos controles nativos do Media3 aparece mesmo com `fullscreenOptions={{ enable: false }}` (expo-video 55.0.21) e só troca o próprio ícone; o app não consegue escondê-lo pelo JavaScript, e "ver em tela cheia" faz esse papel.
- **iOS** (simulador iPhone 17 Pro). A capa toca o vídeo dentro do post com "ver em tela cheia" e o botão de som; a tela cheia abre e fecha de volta ao player. O AVPlayer não mostra controles próprios. O simulador não tem VoiceOver: a conferência com VoiceOver fica para um iPhone físico (abaixo).
- **Web** (Chromium, janela de 430 px). O botão da capa fica fora da camada escondida, e a imagem dentro dele continua escondida e fora do Tab. Enter na capa toca o vídeo e põe o foco nele; o Tab segue para "Silenciar som" e "ver em tela cheia". A tela cheia abre com o foco no vídeo dela, e "fechar" devolve o foco ao vídeo do post. O layout do post não mudou nas três plataformas.

Não conferido: o app com conta (o build de debug não entra com passkey de produção), Safari, o PWA instalado e aparelhos físicos. Fica para a #224.

## O que fica para a #224

- Percorrer as seções 181, 182, 183 e 188 de `docs/verification.md` com conta, em aparelho físico Android e iPhone, com outra conta lendo, no Safari e no PWA instalado. O build de debug não entra com passkey de produção.
- Publicar um arquivo real de câmera de celular com localização (Android, iOS, web e PWA) e conferir em hexadecimal que os bytes publicados não têm `udta`, `meta`, `uuid` nem localização (seção 181).
- iPhone físico: registrar se a segunda passagem a 768 px acontece fora do simulador (seção 183).
- VoiceOver num iPhone físico no vídeo dentro do post.
- Quem opera: atualizar semeadores e serviço de conta antes do app que publica vídeo (pedido do #495), e agora também antes de contar com o bloqueio apagando blobs de momento. Um diretório de blob que o semeador não consegue remover para o semeador até ser corrigido.
