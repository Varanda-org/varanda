### Corrigido

- Chaves de Página no app (PR `fix/paginas-app-chaves`, parte da #352): ao encerrar uma Página, e quando a lista de Páginas mostra que a pessoa deixou de ser dona ou admin de uma, o aparelho esquece as chaves e as conversas dela (`dm.pageForget`). O aviso de "chave diferente" aparece ao abrir as Conversas da Página, logo depois que o nó avisa, com um botão para ler a chave de novo, em vez de só ao tentar enviar. O texto de Avisos vazios da Página cita curtidas e republicações. Sem mudança de formato, RPC nem Termos. Verificação em `docs/verification/fix-paginas-app-chaves.md`.
