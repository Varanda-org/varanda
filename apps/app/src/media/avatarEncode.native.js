// Native stub: profile photos are prepared only on the web (see
// avatarEncode.web.js).
export function openImage () {
  return Promise.reject(new Error('mídia disponível só na versão web'))
}
