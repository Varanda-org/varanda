### Corrigido

- Uma foto de perfil que não desenha (arquivo apagado do cache ou que o aparelho não consegue abrir) é carregada mais uma vez antes de ficar nas iniciais. Uma cópia guardada que falhou é apagada para ser baixada e conferida de novo; se o aparelho não conseguir apagá-la, a foto é baixada de novo sem passar pela cópia guardada até a próxima abertura (verificação em `docs/verification/fix-android-rua-avatars.md`).
