#!/usr/bin/env bash
# Captura a tela do simulador iOS ou do emulador Android ligado, para a
# revisão visual de docs/design-review.md. Cada captura vai para
# <outdir>/<label>-<platform>-<n>.png, com n sequencial, para que uma
# rodada nova nunca sobrescreva a anterior.
# Uso: bash scripts/review-shots.sh <ios|android> <outdir> <label>
set -euo pipefail

usage () {
  echo "uso: review-shots.sh <ios|android> <outdir> <label>" >&2
  exit 2
}

[ "$#" -eq 3 ] || usage
platform="$1"
outdir="$2"
label="$3"

case "$platform" in
  ios | android) ;;
  *) usage ;;
esac

case "$label" in
  '' | *[!A-Za-z0-9._-]*)
    echo "review-shots: label deve usar só letras, números, ponto, traço e sublinhado" >&2
    exit 2
    ;;
esac

adb_devices () {
  adb devices 2>/dev/null | awk 'NR > 1 && $2 == "device" { print $1 }'
}

booted () {
  if [ "$platform" = "ios" ]; then
    xcrun simctl list devices booted 2>/dev/null | grep -q "(Booted)"
  else
    [ -n "$(adb_devices)" ]
  fi
}

if ! booted; then
  echo "Nenhum simulador ou emulador ligado" >&2
  exit 1
fi

serial="${ANDROID_SERIAL:-}"
if [ "$platform" = "android" ] && [ -z "$serial" ]; then
  if [ "$(adb_devices | wc -l | tr -d ' ')" -gt 1 ]; then
    echo "Mais de um aparelho ligado: defina ANDROID_SERIAL" >&2
    exit 1
  fi
fi

creation_failed () {
  echo "Não foi possível criar o arquivo em $outdir" >&2
  exit 1
}

mkdir -p "$outdir" 2>/dev/null || creation_failed

# Reserva o nome de forma atômica: o noclobber faz a criação falhar se outra
# execução já pegou o mesmo n, e então tentamos o próximo. Uma colisão se
# reconhece pelo arquivo existir, não pela mensagem do bash (que muda com o
# idioma); qualquer outra falha é permanente.
n=1
shot=""
while [ "$n" -le 1000 ]; do
  candidate="$outdir/$label-$platform-$n.png"
  if ( set -o noclobber; : > "$candidate" ) 2>/dev/null; then
    shot="$candidate"
    break
  fi
  [ -f "$candidate" ] || creation_failed
  n=$((n + 1))
done
[ -n "$shot" ] || creation_failed

# Daqui em diante, qualquer saída antes do fim (falha, captura vazia, Ctrl-C)
# apaga a reserva, para nenhum png vazio ou cortado ficar na pasta.
tmp=""
finished=0
cleanup () {
  [ -z "$tmp" ] || rm -f "$tmp"
  [ "$finished" = 1 ] || rm -f "$shot"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

tmp="$(mktemp "${TMPDIR:-/tmp}/review-shots.XXXXXX")"

if [ "$platform" = "ios" ]; then
  xcrun simctl io booted screenshot --type=png "$tmp"
elif [ -n "$serial" ]; then
  adb -s "$serial" exec-out screencap -p > "$tmp"
else
  adb exec-out screencap -p > "$tmp"
fi

if [ ! -s "$tmp" ]; then
  echo "review-shots: a captura saiu vazia" >&2
  exit 1
fi

cat "$tmp" > "$shot"
finished=1

echo "$shot"
