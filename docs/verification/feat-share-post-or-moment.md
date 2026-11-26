# Compartilhar como publicação ou momento (branch feat/share-post-or-moment)

## O que muda

- `apps/app/src/sharedIntent.js`: `shareMomentKind` (foto ou vídeo único, sem nada de fora), `shareAsks`, `momentShareText`, `momentShareBack` e `MOMENT_SHARE_BACK`.
- `apps/app/App.js`: com exatamente uma foto ou um vídeo limpo e um momento possível (para vídeo, com o aparelho compondo vídeo), a folha "Compartilhar como" oferece "Publicação" (fica no seu Diário) e "Momento" (some em 24 horas; vídeo: até 15 segundos). Fechar sem escolher descarta o compartilhamento e não mexe em rascunho. A escolha fica por id de compartilhamento, também depois de bloquear e desbloquear. Qualquer outro caso abre a publicação como antes.
- `apps/app/src/screens/Publicar.js`: `sharedAs` `'moment'` liga o modo momento, põe o texto compartilhado na nota do momento (cortado no limite, com aviso) e coloca a foto ou o clipe no lugar do que o momento tinha. Um vídeo recusado só pelos limites (`OVER_LIMIT`) passa uma vez para publicação, com aviso; outras recusas mostram o erro. Se o momento deixou de ser possível, abre como publicação, com aviso.
- `apps/app/src/media/videoPrep.native.js` e `videoPrep.web.js`: a recusa por tamanho ou duração leva `code` `OVER_LIMIT` e `limitMs` (web: só quando os limites da publicação aceitariam o clipe; nativo: no caminho de "longo demais" do módulo).
- `apps/app/src/ui/ActionsSheet.js`: uma linha chama `onClose('action')`; dispensar a folha não.
- Sem mudança nos Termos.

## Testes

Cada arquivo rodou sozinho (`node apps/app/test/<arquivo>.test.js`):

- `sharedIntent`: 320 asserções.
- `shareShell`: 210 asserções.
- `momentosScreen`: 183 testes, 1542 asserções.
- `videoCompose`: 301 asserções.
- `publicarFrame`, `momentPhotos`, `composePolish`, `musicDraft`, `gifPicker`, `platformGate`, `sheetHandover`, `shellChrome`, `uiKit`, `videoPrep`, `feiraCompose`: passou.

Landing: `npm run lint` passou; os testes do diff (os arquivos de teste alterados e os que leem os módulos alterados, 102 arquivos, cada um com `node`) passaram; `npm run demo` terminou com DEMO OK.

A suíte inteira roda na CI do GitHub.

## Limites conhecidos

- Um vídeo compartilhado com mais de 30 segundos, escolhido como momento, também passa para publicação no nativo (o módulo não informa a duração) e lá é recusado: o aviso mostra o limite de 30 segundos e o compartilhamento é liberado.
- Um vídeo que já estava no momento sai antes do preparo do vídeo compartilhado e não volta se o preparo falhar.
- Cancelar o preparo de um clipe compartilhado libera o compartilhamento.
- Restaurar o texto do momento depois do retorno para publicação descarta edições feitas durante o preparo.
- Um segundo compartilhamento que chega enquanto o primeiro ainda prepara não cancela o primeiro: o que terminar por último fica no momento.
- Trocar para "Publicação" enquanto um compartilhamento prepara no momento deixa a mídia fora do rascunho; o arquivo só sai quando o compartilhamento vence.
- Uma foto compartilhada que não abre no momento fica no rascunho do momento, com o erro, depois do retorno para publicação.
- Bloquear o app durante o preparo perde o compartilhamento, como já acontece hoje no caminho de publicação.

## Nos aparelhos

Não conferido aqui, a fazer:

- Compartilhar uma foto e um vídeo da galeria do Android e do app Fotos do iOS, escolher "Momento" e "Publicação", e fechar a folha sem escolher.
- O momento exige uma conta hospedada.
