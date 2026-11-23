# feat/post-frame-composer

Empilhado sobre `feat/post-media-frames`. As fotos de uma publicação comum saem num formato só (Retrato 4:5, Quadrado 1:1 ou Paisagem 16:9). A primeira foto escolhe o formato, e as outras são cortadas ao centro para ele na mesma codificação. O botão "Formato", abaixo das miniaturas, abre o enquadramento no lugar do texto, dentro da folha: dá para trocar o formato e arrastar ou aproximar cada foto. Aplicar recodifica, uma foto por vez, só as fotos que mudaram; se uma falhar, nenhuma muda e o formato anterior fica. Vídeo, momentos, conversas e momento de Página não mudam. O protocolo e o envio não mudam: o corte já está nos bytes.

## O que mudou aqui

- `apps/app/src/media/crop.js`: as contas de corte aceitam a proporção do formato (sem ela, o corte quadrado do avatar fica igual). `frameRect` devolve um retângulo inteiro sempre dentro da imagem.
- `apps/app/src/media/encode.native.js` e `encode.web.js`: `cropFor` corta antes de reduzir; `whole` guarda no aparelho uma cópia inteira de até 1280 px para reenquadrar depois; `encodeBytes` recodifica bytes já guardados. No iPhone, o AVIF com corte passa por um JPEG intermediário, apagado em seguida. Um GIF nunca é cortado.
- `apps/app/src/frameDraft.js` (novo): regras puras do formato no compositor (formato inicial, quando o enquadramento abre, quais fotos recodificar, GIF na frente).
- `apps/app/src/ui/FrameEditor.js` (novo): o enquadramento, com três formatos, arrastar, Aproximar, Afastar, Centralizar, setas e teclas na web, e "foto N de M". Com um GIF na frente, só o formato dele fica disponível. A ajuda fica em `HELP.enquadramento` (`apps/app/src/help.js`).
- `apps/app/src/screens/Publicar.js`: o formato da publicação, o botão Formato, o lote de reenquadramento (tudo ou nada) e o arquivo original guardado para reenquadrar. Enquanto o lote roda, Publicar, anexar, remover, mover e Formato ficam desligados, e um compartilhamento que chega espera o lote terminar. Uma foto cujo envio falhou de vez também é reenquadrada e sobe de novo no formato novo. O original só é usado enquanto o corte é relativo a ele; quando o corte passa a valer sobre bytes já cortados, o original é esquecido, para que um reenquadramento nunca mostre uma parte da foto que o enquadramento não mostrou.
- Testes alterados de propósito: `composePolish.test.js` (a folha fecha só o enquadramento enquanto ele está aberto) e `shareShell.test.js` (o efeito do compartilhamento também roda de novo quando um lote termina).

## Testes rodados

Localmente, cada arquivo sozinho com `node <arquivo>`, mais `npm run lint` e `npm run demo`. A suíte inteira roda na CI do GitHub, no Node 20 e no 24.

- `npm run lint`: passou.
- `npm run demo`: terminou com `DEMO OK`.
- Testes novos ou alterados, todos passaram: `publicarFrame` (11 testes, 44 asserções), `frameDraft` (11, 136), `frameEditor` (7, 28), `encodeCrop` (5, 31), `encodeNative` (23, 228), `mediaCrop` (18, 3970), `help` (15, 598), `composePolish` (17, 228), `shareShell` (8, 49).
- Os 74 arquivos que leem algum módulo alterado por este PR ou pelo PR de baixo passaram, entre eles `musicDraft`, `videoCompose`, `postShareCompose`, `encodePhotoCap`, `stillPlan`, `linkCardBuild`, `platformGate`, `uiKit` e os testes de `feat/post-media-frames`.
- Regressões que falham sem a correção: as três de `publicarFrame` sobre o original esquecido (8 de 11 testes passam sem ela) e a de `frameEditor` sobre as teclas vindas da folha de ajuda.

## Conferências humanas (não feitas)

Em cada plataforma: emulador Android (build de debug), simulador iOS e web/PWA.

- [ ] Uma foto 3:4 da câmera vira 4:5 (Retrato).
- [ ] Uma foto 4:3 em paisagem começa como Quadrado.
- [ ] Um carrossel misto é cortado para o formato da primeira foto, e a publicação mantém a mesma altura ao deslizar.
- [ ] Trocar o formato, arrastar e aproximar, publicar e comparar o feed com a prévia do enquadramento.
- [ ] Num celular pequeno (375x667), o enquadramento rola até Aplicar e Cancelar, e arrastar a foto não rola a folha no Android nem no iOS.
- [ ] Uma foto girada por EXIF corta a região certa (o codificador confia na largura e na altura do seletor).
- [ ] iPhone: AVIF com corte sai em AVIF e no formato certo.
- [ ] PNG com transparência continua transparente.
- [ ] Um GIF fica inteiro, sozinho e como primeira foto, inclusive depois de mover um GIF para a frente (o formato fica preso ao dele).
- [ ] Fotos vindas de um compartilhamento podem ser enquadradas; um compartilhamento que chega durante um reenquadramento entra no formato novo.
- [ ] Uma falha no reenquadramento deixa as fotos como estavam e mostra o aviso.
- [ ] Publicar como Página.
- [ ] Um envio que falha e depois "tentar de novo" manda os bytes já enquadrados; uma foto que falhou de vez e é reenquadrada sobe no formato novo.
- [ ] Web: teclado e leitor de tela no enquadramento (setas, + - 0; Escape fecha só o enquadramento e mantém o rascunho). Com a folha de ajuda aberta, as teclas não mexem na foto.
- [ ] Android: o botão voltar fecha só o enquadramento.
- [ ] O tempo para anexar dez fotos é aceitável.
- [ ] Uma versão anterior do app mostra a publicação nova corretamente.
