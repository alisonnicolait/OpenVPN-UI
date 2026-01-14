# OpenVPN UI – Gerenciador Web de Clientes OpenVPN

Interface web simples e segura para **criar, listar, baixar e revogar clientes OpenVPN**  
utilizando **Easy-RSA já existente no servidor**, sem necessidade de acesso via SSH para tarefas do dia a dia.

A aplicação executa scripts existentes de criação de clientes (`ovpn-novo-cliente.sh`)
e disponibiliza os arquivos `.ovpn` para download via navegador.

****** OBSERVACAO NECESSARIO EDITAR O SCRIPT PARA SETAR PASTA E IP DA VPN E SERVIDOR ******
---

## 📌 Visão Geral

- Interface web protegida por autenticação
- Geração de clientes OpenVPN via Easy-RSA
- Download dos arquivos `.ovpn`
- Listagem de clientes existentes
- Revogação de certificados
- Execução **controlada** de scripts no servidor
- Funcionamento atrás de **NGINX + HTTPS**
- Ideal para servidores com múltiplos clientes VPN

---

## 🧱 Arquitetura

[ Browser ]
|
| HTTPS
v
[ NGINX (Reverse Proxy) ]
|
| HTTP interno
v
[ ovpn-ui (Node.js + Express) ]
|
| exec bash
v
[ Easy-RSA + OpenVPN ]

---

## 📂 Estrutura do Projeto

ovpn-ui/
├── Dockerfile
├── package.json
├── server.js
├── README.md

No servidor, fora do container:

**** EDITAR NO SCRIPT A PASTA

/home/USUARIO DO SERVIDOR/
├── openvpn-ca/               # Easy-RSA + PKI
├── openvpn-clients/          # Onde os .ovpn são gerados
├── ovpn-novo-cliente.sh      # Script original
├── ovpn-novo-cliente.container.sh

---

## ✅ Pré-requisitos do Servidor

### Sistema
- Linux (Ubuntu / Debian recomendado)
- Acesso root ou sudo

### Software
- Docker
- Docker Compose (opcional)
- OpenVPN já configurado
- Easy-RSA já inicializado
- NGINX (como reverse proxy)
- Certbot (Let's Encrypt)

---

## 🔐 Pré-requisitos do OpenVPN

O servidor **já deve ter**:

- Easy-RSA configurado
- CA criada
- PKI funcional
- Script de criação de clientes funcionando via terminal

Teste obrigatório antes de continuar:

```bash
cd /home/USUARIO DO SERVIDOR/openvpn-ca
/home/USUARIO DO SERVIDOR/ovpn-novo-cliente.container.sh teste_manual

### 🐳 Build da Imagem Docker

docker build -t ovpn-ui:latest .

### ▶️ Subindo o Container

docker run -d --name ovpn-ui \
  --restart unless-stopped \
  --network iotalltech-net \
  -p 127.0.0.1:9001:9001 \
  -e UI_USER=admin \
  -e UI_PASS='SENHA_FORTE_AQUI' \
  -e PORT=9001 \
  -e OVPN_SCRIPT=/home/alison/ovpn-novo-cliente.container.sh \
  -e OVPN_OUTDIR=/home/USUARIO DO SERVIDOR/openvpn-clients \
  -v /home/USUARIO DO SERVIDOR/ovpn-novo-cliente.container.sh:/home/USUARIO DO SERVIDOR/ovpn-novo-cliente.container.sh:ro \
  -v /home/USUARIO DO SERVIDOR/openvpn-clients:/home/USUARIO DO SERVIDOR/openvpn-clients \
  -v /home/USUARIO DO SERVIDOR/openvpn-ca:/home/USUARIO DO SERVIDOR/openvpn-ca \
  -w /home/USUARIO DO SERVIDOR/openvpn-ca \
  ovpn-ui:latest
