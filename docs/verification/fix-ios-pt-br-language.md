# iOS: idioma pt-BR na App Store

Branch `fix/ios-pt-br-language`.

## O que foi conferido

- A página da App Store da versão 0.1.0 (build 40) mostrava "Idioma: EN, Inglês". O projeto Xcode tinha `developmentRegion = en`, `knownRegions` com `en` e `Base`, nenhuma pasta `.lproj` e nenhum `CFBundleLocalizations`.
- `node apps/app/test/hardening.test.js`: o teste novo exige `CFBundleDevelopmentRegion` e `CFBundleLocalizations` em `pt-BR` no `app.json` e nos `Info.plist` do app e da extensão, `developmentRegion = "pt-BR"` no `project.pbxproj` e nenhuma região `en`. Sem a mudança, o teste falha (um `not ok`); com ela, passa.
- O `app.json` repete as duas chaves em `ios.infoPlist`, para que um prebuild gere o mesmo `Info.plist`.

## O que ficou de fora

- Não houve build nem envio. O idioma da página só muda quando um build novo, com esta mudança, for aprovado e publicado.
- A Apple deduz o idioma do binário. Se alguma dependência trouxer uma pasta `en.lproj` para o pacote do app, a página pode mostrar os dois idiomas. Confira a página depois do próximo lançamento.
