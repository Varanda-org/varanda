- Sobras da mídia nas conversas, segunda parte da #443 (PR `fix/chat-media-leftovers-app`): app, nó do navegador e Termos 65. Verificação em `docs/verification/fix-chat-media-leftovers-app.md`.

### Alterado

- Mensagens diretas: a cópia cifrada das fotos, GIFs e mensagens de voz já abertas continua no aparelho quando o app bloqueia, então elas abrem sem baixar de novo. Sair e Recomeçar ainda apagam a cópia. Os Termos e a Política de Privacidade passam à versão 65 e pedem novo aceite.
- App nativo: um link que redireciona (um link encurtado, por exemplo) ganha prévia quando o app está ligado à instalação da associação. O aparelho continua sem seguir o redirecionamento e pede a prévia ao serviço de conta, como a versão web hospedada; antes, o link ficava sem prévia.

### Corrigido

- Fotos: o nó do navegador confere que toda foto é a imagem que diz ser antes de guardá-la, também numa publicação e num grupo público, não só numa foto cifrada.
- App nativo: a miniatura de uma foto tirada com o celular de lado mantém a proporção (orientação EXIF).
- Mensagens de voz: um AAC cuja taxa de amostragem o faria tocar por mais tempo do que as amostras dizem é recusado.
- Mensagens diretas: uma falha ao ler a cópia cifrada de uma mídia aberta baixa a mídia de novo só naquela vez e mantém a cópia, em vez de descartá-la.
