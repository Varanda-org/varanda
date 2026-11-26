# Verificação: seguir por QR (#52)

- `node apps/app/test/profileQr.test.js`: só um link de perfil `https://<host>/@nome` ou `/m/<chave>` vira QR (lista de entradas malformadas recusada); a matriz tem os três padrões de localização e os bits de formato passam no BCH com correção M; o link do código abre o mesmo perfil por `parseAppLink` e grava um convite `new` sem consentimento (o perfil abre com Seguir); um código de outra associação não abre nada neste app.
- Ida e volta com um leitor real: o QR de `https://bora.varanda.app/@ana_lima` e o de `/m/<64 hex>`, desenhados a partir de `profileQr` e lidos pelo `CIDetector` do macOS, devolvem o mesmo texto.
- `eas-preview.test.js`, `hardening.test.js` e `apps/cli/test/deploy.test.js`: o manifesto do Android declara `/@` e `/m/` entre os App Links, e o `apple-app-site-association` lista `/@*` e `/m/*`. A câmera continua removida.
- Lint, testes alvo e `npm run demo` passam localmente; a suíte roda na CI.

Limites:

- Não conferido no emulador Android nem no simulador iOS: a folha "Meu QR" e a abertura do app pela câmera do sistema ficam para um aparelho. Os App Links só valem no build de produção (`app.varanda`) e, no iOS, depois que o operador publicar de novo o `apple-app-site-association`.
- Sem leitor de QR dentro do app: a câmera do celular lê o código. Um leitor no app exigiria a permissão de câmera, hoje removida de propósito.
