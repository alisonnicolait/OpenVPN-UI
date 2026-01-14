#!/usr/bin/env bash
set -euo pipefail

USER_NAME="${1:-}"
if [[ -z "$USER_NAME" ]]; then
  echo "Uso: sudo $0 <USERNAME> [IP_VPN_FIXO]"
  echo "Ex.: sudo $0 usuario01 10.2.0.10"
  exit 1
fi

# === AJUSTE AQUI SE PRECISAR ===
SERVER_PUBLIC_IP="<SERVER_PUBLIC_IP>"
SERVER_PORT="2294"
VPN_NET_PREFIX="<VPN_NET_PREFIX>"
DEFAULT_IP_START="<DEFAULT_IP_START>"

EASYRSA_DIR="/home/<USER>/openvpn-ca"
CLIENT_OUT_DIR="/home/<USER>/openvpn-clients"
CCD_DIR="/etc/openvpn/ccd"

BASE_CONF="${CLIENT_OUT_DIR}/base.conf"

# Se o usuário passar IP fixo como 2º argumento, usa ele
STATIC_IP="${2:-}"

# Garante diretórios
mkdir -p "$CLIENT_OUT_DIR"
sudo mkdir -p "$CCD_DIR"

# Garante base.conf (cria se não existir)
if [[ ! -f "$BASE_CONF" ]]; then
  cat > "$BASE_CONF" <<EOF
client
dev tun
proto udp
remote ${SERVER_PUBLIC_IP} ${SERVER_PORT}
resolv-retry infinite
nobind
persist-key
persist-tun
remote-cert-tls server
cipher AES-256-GCM
auth SHA256
key-direction 1
verb 3
EOF
fi

# Escolhe IP fixo automaticamente se não vier no argumento
if [[ -z "$STATIC_IP" ]]; then
  used="$(sudo ls -1 "$CCD_DIR" 2>/dev/null | tr '\n' ' ')"
  # tenta achar o próximo IP livre 10.7.0.X
  for i in $(seq "$DEFAULT_IP_START" 250); do
    candidate="${VPN_NET_PREFIX}${i}"
    if ! grep -Rqs "$candidate" "$CCD_DIR" 2>/dev/null; then
      STATIC_IP="$candidate"
      break
    fi
  done
fi

if [[ -z "$STATIC_IP" ]]; then
  echo "Não consegui alocar IP fixo automaticamente."
  exit 1
fi

if [[ "$STATIC_IP" != ${VPN_NET_PREFIX}* ]]; then
  echo "IP inválido. Use algo como ${VPN_NET_PREFIX}10"
  exit 1
fi

# Cria/gera cert do cliente
cd "$EASYRSA_DIR"

if [[ -f "pki/issued/${USER_NAME}.crt" ]]; then
  echo "[OK] Cert do cliente já existe: ${USER_NAME}.crt (não vou sobrescrever)"
else
  echo "[INFO] Gerando chave/req do cliente: $USER_NAME"
  ./easyrsa gen-req "$USER_NAME" nopass

  echo "[INFO] Assinando certificado do cliente: $USER_NAME"
  # Assina automaticamente "yes"
  echo yes | ./easyrsa sign-req client "$USER_NAME"
fi

# Configura IP fixo via CCD
# Para topology subnet, a forma correta é: ifconfig-push IP 255.255.255.0
sudo tee "${CCD_DIR}/${USER_NAME}" >/dev/null <<EOF
ifconfig-push ${STATIC_IP} 255.255.255.0
EOF

# Gera o .ovpn completo (com tudo embutido)
OUT_NAME="${USER_NAME}__${STATIC_IP}__${SERVER_PUBLIC_IP}_${SERVER_PORT}.ovpn"
OUT_PATH="${CLIENT_OUT_DIR}/${OUT_NAME}"

cat \
  "$BASE_CONF" \
  <(echo -e "\n# user=${USER_NAME}") \
  <(echo -e "# vpn_ip=${STATIC_IP}") \
  <(echo -e "# server=${SERVER_PUBLIC_IP}:${SERVER_PORT}\n") \
  <(echo -e "<ca>") \
  "${EASYRSA_DIR}/pki/ca.crt" \
  <(echo -e "</ca>\n<cert>") \
  "${EASYRSA_DIR}/pki/issued/${USER_NAME}.crt" \
  <(echo -e "</cert>\n<key>") \
  "${EASYRSA_DIR}/pki/private/${USER_NAME}.key" \
  <(echo -e "</key>\n<tls-auth>") \
  "${EASYRSA_DIR}/ta.key" \
  <(echo -e "</tls-auth>\n") \
  > "$OUT_PATH"

chmod 600 "$OUT_PATH"
chown alison:alison "$OUT_PATH"

echo
echo "[OK] Cliente criado:"
echo "     Usuário:   $USER_NAME"
echo "     IP VPN:    $STATIC_IP"
echo "     Arquivo:   $OUT_PATH"
echo
echo "Para aplicar IP fixo imediatamente (recomendado):"
echo "sudo systemctl restart openvpn@server"
