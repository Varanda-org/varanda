# Leitor de tela em Identidade (#154)

Branch `fix/a11y-identidade`. Fecha parte da #154: nome dos campos, estado do botão da chave e avisos de sucesso. O que exige leitor de tela num aparelho não foi conferido e segue aberto na issue.

## O que mudou

- `screens/Identidade.js`: o campo do certificado tinha um `Label` solto acima e, como nome acessível, o texto de exemplo `{"...": "..."}`. Agora o `Label` é o `label` do próprio `Field`, nos três lugares em que ele aparece.
- `screens/Identidade.js`: "Mostrar chave" e "Esconder chave" passam `expanded`, que o `Btn` já anuncia no nativo e na web.
- `ui/Announcer.js` (novo): região viva sempre montada, sem ocupar espaço, e `announceForAccessibility` no iOS. Usada para a nota do vínculo (`note`), o "Certificado gravado" / "Conta liberada" (`done`) e a nota de cadastro (`regNote`).

## Como verificar

A partir da raiz:

- `node apps/app/test/a11yIdentidade.test.js`
- `npm test -w apps/app`
- `npm run lint`

Caminhada, a fazer com TalkBack (Android) e VoiceOver (iOS), e depois no navegador:

- [ ] Colar um certificado: o campo é lido como "certificado de membro (JSON emitido pela associação)".
- [ ] Gravar o certificado: "Certificado gravado." é anunciado sem mover o foco.
- [ ] Trocar o @nome: o "Pronto: agora você é @..." é anunciado.
- [ ] Ajustes › Identidade: "Mostrar chave" é lido como recolhido e, depois do toque, como expandido.

## Fora desta mudança

- Teste com VoiceOver e TalkBack, e com fonte ampliada (critérios de aceite da #154).
- Os textos de aviso continuam visíveis e legíveis também ao navegar item a item, então o leitor pode dizer o aviso duas vezes: uma ao aparecer, outra ao chegar nele.
