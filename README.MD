# OpenVPN UI – Web Manager for OpenVPN Clients

A simple, secure web interface to manage OpenVPN clients, built on top of an existing Easy-RSA setup.
It allows you to create, list, download and revoke OpenVPN client certificates without SSH access.

This project does **not** replace OpenVPN or Easy-RSA — it orchestrates them safely.

---

## ✨ Features
- 🔐 HTTP Basic Auth (env-based credentials)
- 👤 Create OpenVPN clients via Easy-RSA
- 📄 Download `.ovpn` files (no filesystem paths exposed)
- 📋 List existing client profiles
- ❌ Revoke client certificates
- 🧹 Remove test certificates safely
- 🔁 Works behind NGINX reverse proxy
- 🐳 Docker-based deployment
- 🚫 No OpenVPN private paths exposed in UI

---

## 🧱 Architecture

```
[ Browser ]
     |
     | HTTPS
     v
[ NGINX Reverse Proxy ]
     |
     | HTTP (internal)
     v
[ ovpn-ui (Node.js / Express) ]
     |
     | exec bash scripts
     v
[ Easy-RSA + OpenVPN PKI ]
```

---

## 📁 Project Structure

```
ovpn-ui/
├── Dockerfile
├── package.json
├── server.js
└── README.md
```

---

## 🖥️ Server (outside container)

⚠️ Paths must be adjusted to your server user.

```
/home/&lt;USER&gt;/
├── openvpn-ca/                     # Easy-RSA + PKI
│   └── pki/
├── openvpn-clients/                # Generated .ovpn files
├── ovpn-novo-cliente.sh            # Original working script
└── ovpn-novo-cliente.container.sh  # Container-compatible wrapper
```

---

## ✅ Server Requirements

### Operating System
- Linux (Debian / Ubuntu recommended)

### Required Software
- Docker
- OpenVPN (already configured)
- Easy-RSA (already initialized)
- NGINX (recommended for HTTPS)
- Certbot (optional, for Let’s Encrypt)

---

## 🔐 OpenVPN Prerequisites (MANDATORY)

Before installing **ovpn-ui**, the server must already be working:

- Easy-RSA initialized
- CA created
- PKI functional
- Client generation script works manually

### Mandatory test (outside Docker)

```
cd /home/&lt;USER&gt;/openvpn-ca
/home/&lt;USER&gt;/ovpn-novo-cliente.container.sh test_manual
```

---

## 🐳 Docker Image Build

```
docker build -t ovpn-ui:latest .
```

---

## ▶️ Running the Container

```
docker run -d --name ovpn-ui \
  --restart unless-stopped \
  -p 127.0.0.1:9001:9001 \
  -e UI_USER=admin \
  -e UI_PASS='STRONG_PASSWORD_HERE' \
  -e PORT=9001 \
  -e OVPN_SCRIPT=/home/&lt;USER&gt;/ovpn-novo-cliente.container.sh \
  -e OVPN_OUTDIR=/home/&lt;USER&gt;/openvpn-clients \
  -v /home/&lt;USER&gt;/ovpn-novo-cliente.container.sh:/home/&lt;USER&gt;/ovpn-novo-cliente.container.sh:ro \
  -v /home/&lt;USER&gt;/openvpn-clients:/home/&lt;USER&gt;/openvpn-clients \
  -v /home/&lt;USER&gt;/openvpn-ca:/home/&lt;USER&gt;/openvpn-ca \
  -w /home/&lt;USER&gt;/openvpn-ca \
  ovpn-ui:latest
```

---

## 🌐 Web Routes

### Health Check

```
GET /health
```
Response:
```json
{ "ok": true }
```

---

## 🖥️ UI (Protected)

```
GET /
```
- Client creation form  
- Client list  
- Download & revoke actions  

---

## ➕ Create Client

```
POST /create
```
Form field:
- `username` (3–32 chars, `[a-z0-9_-]`)

---

## 📋 List Clients

```
GET /clients
```
Returns all `.ovpn` files from `OVPN_OUTDIR`.

---

## ⬇️ Download Client

```
GET /download?file=<filename>.ovpn
```

---

## ❌ Revoke Client

```
POST /revoke
```
- Revokes certificate via Easy-RSA
- Removes `.ovpn` file
- Updates CRL

---

## 🧹 Removing Test Certificates

```
cd /home/&lt;USER&gt;/openvpn-ca

./easyrsa revoke test_user
./easyrsa gen-crl

rm -f pki/issued/test_user.crt
rm -f pki/private/test_user.key
rm -f pki/reqs/test_user.req
rm -f /home/&lt;USER&gt;/openvpn-clients/test_user*.ovpn
```

---

## 🔒 Security Notes
- Runs only on `127.0.0.1`
- Must be exposed via NGINX HTTPS
- Uses `sudo -n` (no interactive shell)
- UI credentials stored only via environment variables
- No filesystem paths shown to users

---

## 📜 License

MIT License — use at your own risk.
