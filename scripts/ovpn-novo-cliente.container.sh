#!/usr/bin/env bash
set -e

# ==============================
# CONFIGURAÇÕES
# ==============================
CLIENT="$1"

EASYRSA_DIR="/home/<USER>/openvpn-ca"
OUTDIR="/home/<USER>/openvpn-clients"
BASECONF="$OUTDIR/base.conf"

if [ -z "$CLIENT" ]; then
  echo "Uso: $0 <nome_cliente>"
  exit 1
fi

cd "$EASYRSA_DIR"

# ==============================
# GARANTIR EASYRSA
# ==============================
if [ ! -x "./easyrsa" ]; then
  echo "ERRO: easyrsa não encontrado em $EASYRSA_DIR"
  exit 1
fi

# ==============================
# EVITAR ERRO DE REQ EXISTENTE
# (remove se já existir)
# ==============================
rm -f \
  "pki/reqs/${CLIENT}.req" \
  "pki/private/${CLIENT}.key" \
  "pki/issued/${CLIENT}.crt"

# ==============================
# GERAR CERTIFICADO
# ==============================
./easyrsa build-client-full "$CLIENT" nopass

# ==============================
# LER REMOTE (DNS / PORTA)
# ==============================
REMOTE_HOST="$(awk '$1=="remote"{print $2; exit}' "$BASECONF")"
REMOTE_PORT="$(awk '$1=="remote"{print $3; exit}' "$BASECONF")"

[ -z "$REMOTE_PORT" ] && REMOTE_PORT="1194"

# ==============================
# DESCOBRIR PRÓXIMO IP (sequencial pelos .ovpn gerados)
# ==============================
VPN_NET_PREFIX="10.7.0"
START_OCTET=10

LAST_OCTET="$(ls -1 "$OUTDIR"/*.ovpn 2>/dev/null \
  | sed -nE "s/.*__${VPN_NET_PREFIX}\.([0-9]+)__.*/\1/p" \
  | sort -n \
  | tail -n 1)"

if [ -z "$LAST_OCTET" ]; then
  NEXT_OCTET="$START_OCTET"
else
  NEXT_OCTET=$((LAST_OCTET + 1))
fi

NEXT_IP="${VPN_NET_PREFIX}.${NEXT_OCTET}"
# ==============================
# NOME FINAL DO ARQUIVO
# ==============================
FINAL_NAME="${CLIENT}__${NEXT_IP}__${REMOTE_HOST}_${REMOTE_PORT}.ovpn"
OUTFILE="$OUTDIR/$FINAL_NAME"

# ==============================
# MONTAR O .OVPN
# ==============================
{
  cat "$BASECONF"
  echo
  echo "<ca>"
  cat pki/ca.crt
  echo "</ca>"
  echo "<cert>"
  awk '/BEGIN/,/END/' "pki/issued/${CLIENT}.crt"
  echo "</cert>"
  echo "<key>"
  cat "pki/private/${CLIENT}.key"
  echo "</key>"
  echo "<tls-auth>"
  cat ta.key
  echo "</tls-auth>"
} > "$OUTFILE"

chmod 600 "$OUTFILE"

echo "OK: gerado $FINAL_NAME"
