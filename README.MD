OpenVPN UI – Web Manager for OpenVPN Clients

A simple, secure web interface to manage OpenVPN clients, built on top of an existing Easy-RSA setup.
It allows you to create, list, download and revoke OpenVPN client certificates without SSH access.

This project does not replace OpenVPN or Easy-RSA — it orchestrates them safely.

⸻

✨ Features
	•	🔐 HTTP Basic Auth (env-based credentials)
	•	👤 Create OpenVPN clients via Easy-RSA
	•	📄 Download .ovpn files (no filesystem paths exposed)
	•	📋 List existing client profiles
	•	❌ Revoke client certificates
	•	🧹 Remove test certificates safely
	•	🔁 Works behind NGINX reverse proxy
	•	🐳 Docker-based deployment
	•	🚫 No OpenVPN private paths exposed in UI

⸻

🧱 Architecture
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

📁 Project Structure

ovpn-ui/
├── Dockerfile
├── package.json
├── server.js
└── README.md

Server (outside container)

⚠️ Paths must be adjusted to your server user
```
/home/<USER>/
├── openvpn-ca/                     # Easy-RSA + PKI
│   └── pki/
├── openvpn-clients/                # Generated .ovpn files
├── ovpn-novo-cliente.sh            # Original working script
└── ovpn-novo-cliente.container.sh  # Container-compatible wrapper
```
✅ Server Requirements

Operating System
	•	Linux (Debian / Ubuntu recommended)

Required Software
	•	Docker
	•	OpenVPN (already configured)
	•	Easy-RSA (already initialized)
	•	NGINX (recommended for HTTPS)
	•	Certbot (optional, for Let’s Encrypt)

⸻

🔐 OpenVPN Prerequisites (MANDATORY)

Before installing ovpn-ui, the server must already be working:
	•	Easy-RSA initialized
	•	CA created
	•	PKI functional
	•	Client generation script works manually

Mandatory test (outside Docker):
```
cd /home/<USER>/openvpn-ca
/home/<USER>/ovpn-novo-cliente.container.sh test_manual
```
🐳 Docker Image Build

docker build -t ovpn-ui:latest .

▶️ Running the Container
```
docker run -d --name ovpn-ui \
  --restart unless-stopped \
  -p 127.0.0.1:9001:9001 \
  -e UI_USER=admin \
  -e UI_PASS='STRONG_PASSWORD_HERE' \
  -e PORT=9001 \
  -e OVPN_SCRIPT=/home/<USER>/ovpn-novo-cliente.container.sh \
  -e OVPN_OUTDIR=/home/<USER>/openvpn-clients \
  -v /home/<USER>/ovpn-novo-cliente.container.sh:/home/<USER>/ovpn-novo-cliente.container.sh:ro \
  -v /home/<USER>/openvpn-clients:/home/<USER>/openvpn-clients \
  -v /home/<USER>/openvpn-ca:/home/<USER>/openvpn-ca \
  -w /home/<USER>/openvpn-ca \
  ovpn-ui:latest
```
🌐 Web Routes

GET /health

response:
{ "ok": true }

# UI (Protected)

GET /
	•	Client creation form
	•	Client list
	•	Download & revoke actions

# Create Client

POST /create
Form field:
	•	username (3–32 chars, [a-z0-9_-])

# List Clients

GET /clients
Returns all .ovpn files from OVPN_OUTDIR.

# Download Client

GET /download?file=<filename>.ovpn


✅ File path is never exposed
❌ Absolute paths like /home/&lt;USER&gt;/... are hidden


# Revoke Client

POST /revoke
	•	Revokes certificate via Easy-RSA
	•	Removes .ovpn file
	•	Updates CRL

🧹 Removing Test Certificates

## List existing certs
```
ls /home/<USER>/openvpn-ca/pki/issued
```
## Remove a test client
```
cd /home/<USER>/openvpn-ca

./easyrsa revoke test_user
./easyrsa gen-crl

rm -f pki/issued/test_user.crt
rm -f pki/private/test_user.key
rm -f pki/reqs/test_user.req
rm -f /home/<USER>/openvpn-clients/test_user*.ovpn
```
Restart OpenVPN if required.

🔒 Security Notes
	•	Runs only on 127.0.0.1
	•	Must be exposed via NGINX HTTPS
	•	Uses sudo -n (no interactive shell)
	•	UI credentials stored only via environment variables
	•	No filesystem paths shown to users

🔁 NGINX Reverse Proxy Example
```
location /vpn/ {
    proxy_pass http://127.0.0.1:9001/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```
🚀 Recommended Usage
	•	Small teams
	•	MSP / Industrial environments
	•	Remote access control
	•	VPN client lifecycle management

⸻

⚠️ Disclaimer

This project does not secure OpenVPN by itself.
It assumes OpenVPN and Easy-RSA are already secure and maintained.

⸻

📜 License

MIT License – use at your own risk.