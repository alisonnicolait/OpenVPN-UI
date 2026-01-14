"use strict";

const express = require("express");
const basicAuth = require("express-basic-auth");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");

const maskPaths = (s = "") =>
  String(s).replace(/\/home\/[^\s]*/g, "[hidden]");

const esc = (s="") =>
  String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

const app = express();

// ===== Config =====
const UI_USER = process.env.UI_USER || "admin";
const UI_PASS = process.env.UI_PASS || "admin";
const PORT = Number(process.env.PORT || 9001);

// script que gera o cliente (dentro do container)
const SCRIPT = process.env.OVPN_SCRIPT || "/home/alison/ovpn-novo-cliente.container.sh";

// pasta onde ficam os .ovpn (dentro do container)
const OUT_DIR = process.env.OVPN_OUT_DIR || process.env.OVPN_OUT_DIR /* compat */ || "/home/alison/openvpn-clients";

// diretório do EasyRSA (onde tem ./easyrsa e pki/)
const WORKDIR = process.env.OVPN_WORKDIR || "/home/alison/openvpn-ca";

// CRL gerada pelo EasyRSA
const CRL_PATH = process.env.OVPN_CRL_OUT || path.join(WORKDIR, "pki", "crl.pem");

// opcional: onde “deployar” a CRL para o OpenVPN server usar
// (só funciona se você montar esse path no container com -v)
const CRL_DEPLOY = process.env.OVPN_CRL_DEPLOY || "";

// ===== Segurança / Proxy =====
app.set("trust proxy", true); // importante quando está atrás do NGINX

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.urlencoded({ extended: false }));

app.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

const auth = basicAuth({
  users: { [UI_USER]: UI_PASS },
  challenge: true,
  realm: "OpenVPN UI",
});

// ===== Utils =====

function validUsername(u) {
  // CN/username: 3-32, letras/números/_-
  return /^[a-z0-9_-]{3,32}$/i.test(u);
}

function safeJoin(base, file) {
  // evita ../../ etc
  const full = path.resolve(base, file);
  if (!full.startsWith(path.resolve(base) + path.sep)) return null;
  return full;
}

function listOvpnFiles() {
  try {
    return fs.readdirSync(OUT_DIR)
      .filter(f => f.toLowerCase().endsWith(".ovpn"))
      .sort((a, b) => b.localeCompare(a));
  } catch {
    return [];
  }
}

function listOvpnForUser(username) {
  const files = listOvpnFiles().filter(f => f.toLowerCase().startsWith(username.toLowerCase()));
  return files;
}

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, {
      timeout: 180000,
      ...opts,
    }, (err, stdout, stderr) => {
      if (err) {
        err._stdout = stdout || "";
        err._stderr = stderr || "";
        return reject(err);
      }
      resolve({ stdout: stdout || "", stderr: stderr || "" });
    });
  });
}

async function createClient(username) {
  // roda seu script
  // (sem sudo: container já roda como root normalmente; e evita “sudo: command not found”)
  return runCmd("/bin/bash", ["-lc", `${SCRIPT} ${username}`], {
    cwd: WORKDIR,
    env: { ...process.env },
  });
}

async function revokeClient(username) {
  // revoke + gen-crl (modo batch pra não pedir confirmação)
  const env = { ...process.env, EASYRSA_BATCH: "1" };

  // algumas instalações preferem chamar ./easyrsa; outras “easyrsa” no PATH.
  // como você tem ./easyrsa no WORKDIR, vamos usar ele.
  await runCmd("/bin/bash", ["-lc", `./easyrsa revoke ${username}`], { cwd: WORKDIR, env });
  await runCmd("/bin/bash", ["-lc", `./easyrsa gen-crl`], { cwd: WORKDIR, env });

  // opcional: deploy do crl.pem pra onde o OpenVPN server lê
  if (CRL_DEPLOY) {
    await runCmd("/bin/bash", ["-lc", `cp -f ${CRL_PATH} ${CRL_DEPLOY} && chmod 644 ${CRL_DEPLOY}`], { cwd: WORKDIR, env });
  }

  return true;
}

// ===== UI (HTML inline) =====
function page({ title, body, note = "" }) {
  return `<!doctype html>
<html lang="pt-br">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(title)}</title>
<style>
  :root{
    --bg:#0b1220; --card:#111a2b; --txt:#e7edf7; --mut:#9fb0c8;
    --pri:#5cc8ff; --ok:#46d17d; --bad:#ff5c7a; --brd:rgba(255,255,255,.10);
  }
  *{box-sizing:border-box}
  body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,sans-serif;background:linear-gradient(180deg,#070b14,var(--bg));color:var(--txt)}
  .wrap{max-width:980px;margin:40px auto;padding:0 16px}
  .top{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:18px}
  .brand{display:flex;align-items:center;gap:12px}
  .dot{width:10px;height:10px;border-radius:50%;background:var(--pri);box-shadow:0 0 20px rgba(92,200,255,.6)}
  h1{font-size:20px;margin:0}
  .mut{color:var(--mut);font-size:13px;margin-top:4px}
  .grid{display:grid;grid-template-columns:1fr;gap:14px}
  @media(min-width:900px){ .grid{grid-template-columns: 1.1fr .9fr} }
  .card{background:rgba(17,26,43,.85);border:1px solid var(--brd);border-radius:16px;padding:16px;backdrop-filter: blur(8px)}
  label{display:block;font-size:13px;color:var(--mut);margin-bottom:6px}
  input{width:100%;padding:12px 12px;border-radius:12px;border:1px solid var(--brd);background:#0c1424;color:var(--txt);outline:none}
  input:focus{border-color:rgba(92,200,255,.7);box-shadow:0 0 0 4px rgba(92,200,255,.08)}
  .row{display:flex;gap:10px;align-items:center}
  .btn{appearance:none;border:0;border-radius:12px;padding:12px 14px;font-weight:600;cursor:pointer}
  .btn-primary{background:linear-gradient(180deg,rgba(92,200,255,.95),rgba(92,200,255,.70));color:#07101f}
  .btn-ghost{background:transparent;border:1px solid var(--brd);color:var(--txt)}
  .btn-danger{background:linear-gradient(180deg,rgba(255,92,122,.95),rgba(255,92,122,.70));color:#1b0710}
  .btn:disabled{opacity:.6;cursor:not-allowed}
  .pill{display:inline-flex;align-items:center;gap:8px;border:1px solid var(--brd);background:rgba(12,20,36,.6);border-radius:999px;padding:8px 10px;color:var(--mut);font-size:12px}
  a{color:var(--pri);text-decoration:none}
  a:hover{text-decoration:underline}
  .list{margin:10px 0 0;padding:0;list-style:none}
  .list li{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 0;border-bottom:1px solid rgba(255,255,255,.06)}
  .file{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:12px;color:var(--txt)}
  .ok{color:var(--ok);font-weight:700}
  .bad{color:var(--bad);font-weight:700}
  pre{white-space:pre-wrap;background:#0c1424;border:1px solid var(--brd);border-radius:12px;padding:12px;color:var(--txt);font-size:12px;overflow:auto}
</style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div class="brand">
        <div class="dot"></div>
        <div>
          <h1>${esc(title)}</h1>
          <div class="mut">VPN • geração e revogação de clientes</div>
        </div>
      </div>
     <div class="pill">Download servido por <b style="color:var(--txt);margin-left:6px">/openvpn-clients</b></div>
    </div>

    ${note ? `<div class="card" style="border-color:rgba(92,200,255,.35)">${note}</div>` : ""}

    <div class="grid">
      ${body}
    </div>

    <div class="mut" style="margin-top:16px">
      Desenvolvido por Wizis Intermediações e Negócios Ltda.
    </div>
  </div>
</body>
</html>`;
}

function homeHtml(messageHtml = "") {
  const files = listOvpnFiles().slice(0, 15);

  const left = `
  <div class="card">
    <h3 style="margin:0 0 10px">Gerar cliente</h3>
    <form method="POST" action="/create">
      <label>Usuário (CN)</label>
      <input name="username" placeholder="ex: suporte_01" required />
  <div class="row" style="margin-top:12px;flex-wrap:wrap">
  <button class="btn btn-primary" type="submit">Gerar .ovpn</button>
  <a class="btn btn-ghost" href="/clients">Ver todos</a>
  <a class="btn btn-ghost" href="/connections">Conexões ativas</a>
</div>
    </form>

    <div class="mut" style="margin-top:12px">
      O resultado não mostra caminhos do servidor. Você baixa pelo link gerado.
    </div>

    ${messageHtml ? `<div style="margin-top:12px">${messageHtml}</div>` : ""}
  </div>`;

  const right = `
  <div class="card">
    <h3 style="margin:0 0 10px">Últimos arquivos</h3>
    <ul class="list">
      ${files.map(f => `
        <li>
          <span class="file">${esc(f)}</span>
          <a href="/download?file=${encodeURIComponent(f)}">baixar</a>
        </li>`).join("") || `<li class="mut">Nenhum .ovpn encontrado.</li>`}
    </ul>

    <h3 style="margin:14px 0 10px">Revogar</h3>
    <form method="POST" action="/revoke">
      <label>Usuário (CN) para revogar</label>
      <input name="username" placeholder="ex: suporte_01" required />
      <div class="row" style="margin-top:12px">
        <button class="btn btn-danger" type="submit">Revogar</button>
      </div>
      <div class="mut" style="margin-top:10px">
        Revogação gera um novo <b>crl.pem</b>. Se o OpenVPN estiver configurado com <b>crl-verify</b>, ele passa a bloquear o cliente revogado.
      </div>
    </form>
  </div>`;

  return page({ title: "OpenVPN - Clientes", body: left + right });
}

// ===== Routes =====
app.get("/health", auth, (req, res) => res.json({ ok: true }));

app.get("/", auth, (req, res) => res.type("html").send(homeHtml()));

app.post("/create", auth, async (req, res) => {
  const username = String(req.body.username || "").trim();

  if (!validUsername(username)) {
    return res.status(400).type("html").send(homeHtml(`<div class="bad">Usuário inválido.</div>`));
  }

  try {
    const { stdout, stderr } = await createClient(username);
    const files = listOvpnForUser(username);

    // pega o mais recente desse usuário
    const newest = files[0];

    const msg = `
      <div class="ok">Gerado com sucesso.</div>
      ${newest ? `<div class="mut" style="margin-top:6px"><a href="/download?file=${encodeURIComponent(newest)}">Baixar ${esc(newest)}</a></div>` : ""}
      ${stderr ? `<details style="margin-top:10px"><summary class="mut">ver detalhes</summary><pre>${esc(stderr)}</pre></details>` : ""}
    `;

    return res.type("html").send(homeHtml(msg));
  } catch (err) {
    const code = err?.code ?? "ERR";
    const stdout = err?._stdout || "";
    const stderr = err?._stderr || "";

    const msg = `
      <div class="bad">Falha ao gerar.</div>
      <div class="mut">code=${esc(code)}</div>
      <details style="margin-top:10px" open>
        <summary class="mut">detalhes</summary>
        <pre>${esc(stderr || stdout || String(err))}</pre>
      </details>
    `;
    return res.status(500).type("html").send(homeHtml(msg));
  }
});

app.get("/clients", auth, (req, res) => {
  const files = listOvpnFiles();
  const items = files.map(f => `
    <li>
      <span class="file">${esc(f)}</span>
      <a href="/download?file=${encodeURIComponent(f)}">baixar</a>
    </li>`).join("");

  const body = `
    <div class="card" style="grid-column:1/-1">
      <div class="row" style="justify-content:space-between">
        <h3 style="margin:0">Arquivos .ovpn (${files.length})</h3>
        <a class="btn btn-ghost" href="/">Voltar</a>
      </div>
      <ul class="list" style="margin-top:10px">${items || `<li class="mut">Nenhum arquivo.</li>`}</ul>
    </div>
  `;

  return res.type("html").send(page({
    title: "OpenVPN - Lista de clientes",
    body,
    note: "Downloads",
  }));
});

app.get("/download", auth, (req, res) => {
  const file = String(req.query.file || "");

  if (!file.toLowerCase().endsWith(".ovpn")) {
    return res.status(400).send("Arquivo inválido.");
  }

  const full = safeJoin(OUT_DIR, file);
  if (!full) return res.status(400).send("Arquivo inválido.");

  if (!fs.existsSync(full)) return res.status(404).send("Não encontrado.");

  return res.download(full, file);
});

app.post("/revoke", auth, async (req, res) => {
  const username = String(req.body.username || "").trim();

  if (!validUsername(username)) {
    return res.status(400).type("html").send(homeHtml(`<div class="bad">Usuário inválido.</div>`));
  }

  try {
    await revokeClient(username);

    const note = `
      <div class="ok">Revogado com sucesso: ${esc(username)}</div>
      <div class="mut" style="margin-top:6px">
        CRL atualizada. Se seu OpenVPN usa <b>crl-verify</b>, o cliente passa a ser bloqueado.
      </div>
      ${CRL_DEPLOY ? `<div class="mut" style="margin-top:6px">CRL aplicada em: <span class="file">${esc(CRL_DEPLOY)}</span></div>` : ""}
    `;
    return res.type("html").send(homeHtml(note));
  } catch (err) {
    const code = err?.code ?? "ERR";
    const stdout = err?._stdout || "";
    const stderr = err?._stderr || "";

    const msg = `
      <div class="bad">Falha ao revogar.</div>
      <div class="mut">code=${esc(code)}</div>
      <details style="margin-top:10px" open>
        <summary class="mut">detalhes</summary>
        <pre>${esc(stderr || stdout || String(err))}</pre>
      </details>
    `;
    return res.status(500).type("html").send(homeHtml(msg));
  }
});

// ===== OpenVPN Connections (parse /run/openvpn/server.status) =====
app.get("/connections", auth, (req, res) => {
  const statusFile = process.env.OPENVPN_STATUS || "/run/openvpn/server.status";

  if (!fs.existsSync(statusFile)) {
    return res.status(500).type("html").send(page({
      title: "OpenVPN - Conexões",
      body: `<div class="card" style="grid-column:1/-1">
        <div class="bad">Arquivo de status não encontrado.</div>
        <div class="mut">Caminho esperado: <span class="file">${esc(statusFile)}</span></div>
        <div class="mut" style="margin-top:8px">Monte no container com: <span class="file">-v ${esc(statusFile)}:${esc(statusFile)}:ro</span></div>
      </div>`
    }));
  }

  const txt = fs.readFileSync(statusFile, "utf8");
  const lines = txt.split("\n").map(l => l.trim()).filter(Boolean);

  // pega timestamp "Updated,YYYY-MM-DD HH:MM:SS"
  const updatedLine = lines.find(l => l.startsWith("Updated,"));
  const updated = updatedLine ? updatedLine.split(",").slice(1).join(",") : "";

  // seção CLIENT LIST (CSV)
  const idxClientHeader = lines.findIndex(l => l.startsWith("Common Name,Real Address"));
  const idxRouting = lines.findIndex(l => l === "ROUTING TABLE");

  const clientRows = (idxClientHeader >= 0)
    ? lines.slice(idxClientHeader + 1, idxRouting >= 0 ? idxRouting : lines.length)
    : [];

  const clients = clientRows
    .filter(l => l.includes(","))
    .map(l => {
      const [name, real, rx, tx, since] = l.split(",");
      return { name, real, rx, tx, since };
    });

  const body = `
    <div class="card" style="grid-column:1/-1">
      <div class="row" style="justify-content:space-between;align-items:flex-end">
        <div>
          <h3 style="margin:0">Conexões ativas (${clients.length})</h3>
          <div class="mut">Updated: ${esc(updated || "-")}</div>
        </div>
        <a class="btn btn-ghost" href="/">Voltar</a>
      </div>

      <div style="overflow:auto;margin-top:12px">
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="text-align:left">
              <th style="padding:10px;border-bottom:1px solid rgba(255,255,255,.08);color:var(--mut)">Common Name</th>
              <th style="padding:10px;border-bottom:1px solid rgba(255,255,255,.08);color:var(--mut)">Real Address</th>
              <th style="padding:10px;border-bottom:1px solid rgba(255,255,255,.08);color:var(--mut)">Connected Since</th>
              <th style="padding:10px;border-bottom:1px solid rgba(255,255,255,.08);color:var(--mut)">RX</th>
              <th style="padding:10px;border-bottom:1px solid rgba(255,255,255,.08);color:var(--mut)">TX</th>
            </tr>
          </thead>
          <tbody>
            ${
              clients.length
                ? clients.map(c => `
                  <tr>
                    <td style="padding:10px;border-bottom:1px solid rgba(255,255,255,.06)"><span class="file">${esc(c.name)}</span></td>
                    <td style="padding:10px;border-bottom:1px solid rgba(255,255,255,.06)">${esc(c.real)}</td>
                    <td style="padding:10px;border-bottom:1px solid rgba(255,255,255,.06)">${esc(c.since)}</td>
                    <td style="padding:10px;border-bottom:1px solid rgba(255,255,255,.06)">${esc(c.rx)}</td>
                    <td style="padding:10px;border-bottom:1px solid rgba(255,255,255,.06)">${esc(c.tx)}</td>
                  </tr>
                `).join("")
                : `<tr><td colspan="5" class="mut" style="padding:12px">Nenhum cliente conectado.</td></tr>`
            }
          </tbody>
        </table>
      </div>
    </div>
  `;

  return res.type("html").send(page({ title: "OpenVPN - Conexões", body }));
});

// ===== Start Server =====
app.listen(PORT, "0.0.0.0", () => {
  console.log(`ovpn-ui on http://0.0.0.0:${PORT}`);
});
