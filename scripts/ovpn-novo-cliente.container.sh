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
# DEFINIR IP (CCD É A FONTE DA VERDADE)
# ==============================
VPN_NET_PREFIX="10.7.0"
START_OCTET=10

CCD_DIR="/etc/openvpn/ccd"
CCD_FILE="$CCD_DIR/$CLIENT"

mkdir -p "$CCD_DIR"

# Se já existe CCD, reaproveita o IP
if [ -f "$CCD_FILE" ]; then
  NEXT_IP="$(awk '$1=="ifconfig-push"{print $2; exit}' "$CCD_FILE")"
  if [ -z "$NEXT_IP" ]; then
    echo "ERRO: CCD existe mas IP não encontrado em $CCD_FILE"
    exit 1
  fi
else
  # Descobre último IP usado nos CCDs
  LAST_OCTET="$(awk '$1=="ifconfig-push"{print $2}' "$CCD_DIR"/* 2>/dev/null \
    | sed -nE "s/^${VPN_NET_PREFIX}\.([0-9]+)$/\1/p" \
    | sort -n | tail -n 1)"

  if [ -z "$LAST_OCTET" ]; then
    NEXT_OCTET="$START_OCTET"
  else
    NEXT_OCTET=$((LAST_OCTET + 1))
  fi

  NEXT_IP="${VPN_NET_PREFIX}.${NEXT_OCTET}"

  # Cria CCD
  printf "ifconfig-push %s 255.255.255.0\n" "$NEXT_IP" > "$CCD_FILE"
  chown root:nogroup "$CCD_DIR" "$CCD_FILE" 2>/dev/null || true
  chmod 750 "$CCD_DIR" 2>/dev/null || true
  chmod 640 "$CCD_FILE" 2>/dev/null || true
fi

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
