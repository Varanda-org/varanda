// Native stub: photos are encoded only on the web (see encode.web.js).
export function encodeFile () {
  return Promise.reject(new Error('mídia disponível só na versão web'))
}
