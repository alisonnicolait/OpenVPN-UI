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

const fmtBytes = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v ?? "");
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, x = n;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
  return `${i === 0 ? x : x.toFixed(1)} ${units[i]}`;
};

const app = express();

// ===== Config =====
const UI_USER = process.env.UI_USER || "admin";
const UI_PASS = process.env.UI_PASS || "admin";
const PORT = Number(process.env.PORT || 9001);

// script que gera o cliente (dentro do container)
const SCRIPT = process.env.OVPN_SCRIPT || "/opt/scripts/ovpn-novo-cliente.container.sh";

// pasta onde ficam os .ovpn (dentro do container)
const OUT_DIR = process.env.OVPN_OUT_DIR || process.env.OVPN_OUT_DIR /* compat */ || "/home/alison/openvpn-clients";

// diretório do EasyRSA (onde tem ./easyrsa e pki/)
const WORKDIR = process.env.OVPN_WORKDIR || "/home/alison/openvpn-ca";

// index.txt do EasyRSA: fonte da verdade sobre quem está revogado
const INDEX_PATH = process.env.OVPN_INDEX || path.join(WORKDIR, "pki", "index.txt");

// CCDs (IP fixo por cliente); removidos junto com o .ovpn ao deletar
const CCD_DIR = process.env.OVPN_CCD_DIR || "/etc/openvpn/ccd";

// CRL gerada pelo EasyRSA
const CRL_PATH = process.env.OVPN_CRL_OUT || path.join(WORKDIR, "pki", "crl.pem");

// opcional: onde “deployar” a CRL para o OpenVPN server usar
// (só funciona se você montar esse path no container com -v)
const CRL_DEPLOY = process.env.OVPN_CRL_DEPLOY || "";

// ===== Segurança / Proxy =====
app.set("trust proxy", false); // sem trust proxy pra não quebrar o express-rate-limit

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.urlencoded({ extended: false }));

// rateLimit desativado (estava gerando ValidationError trust proxy)

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

// nome do arquivo é "CN__IP__host_port.ovpn"
function cnFromFile(file) {
  return String(file).replace(/\.ovpn$/i, "").split("__")[0];
}

function ipFromFile(file) {
  const m = String(file).match(/__((?:\d{1,3}\.){3}\d{1,3})__/);
  return m ? m[1] : "";
}

// CNs revogados segundo o index.txt do EasyRSA (linhas que começam com "R")
function revokedCNs() {
  const set = new Set();
  try {
    for (const line of fs.readFileSync(INDEX_PATH, "utf8").split("\n")) {
      if (!line.startsWith("R")) continue;
      const m = line.match(/\/CN=([^/\s]+)/);
      if (m) set.add(m[1]);
    }
  } catch { /* sem index.txt: ninguém é marcado como revogado */ }
  return set;
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
function page({ title, heading, subtitle = "", body, active = "", back = null }) {
  const tab = (href, label) =>
    `<a class="tab${active === href ? " is-active" : ""}" href="${href}">${label}</a>`;

  const backLink = back
    ? `<a class="back" href="${back.href}">
         <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
           <path d="M10 3 5 8l5 5"/>
         </svg>
         ${esc(back.label)}
       </a>`
    : "";

  return `<!doctype html>
<html lang="pt-br">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(title)}</title>
<style>
  :root{
    --bg:#f6f7f9; --surface:#fff; --surface-2:#fbfcfd;
    --txt:#16202c; --mut:#657084; --brd:#e2e6ec;
    --acc:#1f5fd6; --acc-weak:#eef3fd;
    --ok:#12704f; --ok-weak:#e8f5f0;
    --bad:#a52320; --bad-weak:#fdeceb;
    --radius:8px;
  }
  @media (prefers-color-scheme: dark){
    :root{
      --bg:#0f1319; --surface:#161b23; --surface-2:#1b212a;
      --txt:#e6e9ee; --mut:#9aa4b2; --brd:#2a323d;
      --acc:#6ea8fe; --acc-weak:#1b2739;
      --ok:#5fd0a0; --ok-weak:#16281f;
      --bad:#f28b82; --bad-weak:#2c1d1d;
    }
  }
  *{box-sizing:border-box}
  body{
    margin:0;background:var(--bg);color:var(--txt);
    font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Ubuntu,"Helvetica Neue",Arial,sans-serif;
    -webkit-font-smoothing:antialiased;
  }
  .shell{max-width:1080px;margin:0 auto;padding:0 20px}

  header{border-bottom:1px solid var(--brd);background:var(--surface)}
  .header-in{display:flex;align-items:center;justify-content:space-between;gap:16px;height:56px}
  .brand{display:flex;align-items:center;gap:10px;font-weight:600;letter-spacing:-.01em}
  .brand svg{display:block;color:var(--mut)}
  .nav{display:flex;gap:4px}
  .tab{
    display:inline-flex;align-items:center;height:32px;padding:0 12px;border-radius:6px;
    color:var(--mut);text-decoration:none;font-weight:500;
  }
  .tab:hover{background:var(--surface-2);color:var(--txt)}
  .tab.is-active{background:var(--acc-weak);color:var(--acc)}

  main{padding:28px 0 40px}
  .page-head{margin-bottom:20px}
  .back{display:inline-flex;align-items:center;gap:4px;color:var(--mut);text-decoration:none;font-size:13px;font-weight:500;margin-bottom:10px}
  .back:hover{color:var(--txt)}
  h1{margin:0;font-size:20px;font-weight:600;letter-spacing:-.01em}
  .sub{color:var(--mut);margin-top:4px}
  h2{margin:0;font-size:15px;font-weight:600}

  /* minmax(0,..): sem isso um nome de arquivo longo estica a coluna e espreme a pagina */
  .grid{display:grid;grid-template-columns:minmax(0,1fr);gap:16px}
  @media(min-width:900px){ .grid{grid-template-columns:minmax(0,1fr) minmax(0,1fr)} }
  .span-all{grid-column:1/-1}

  .card{background:var(--surface);border:1px solid var(--brd);border-radius:var(--radius);min-width:0}
  .card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;border-bottom:1px solid var(--brd)}
  .card-body{padding:16px}
  .card-foot{padding:12px 16px;border-top:1px solid var(--brd);color:var(--mut);font-size:13px;background:var(--surface-2);border-radius:0 0 var(--radius) var(--radius)}

  label{display:block;font-size:13px;font-weight:500;margin-bottom:6px}
  input{
    width:100%;height:36px;padding:0 10px;border:1px solid var(--brd);border-radius:6px;
    background:var(--surface);color:var(--txt);font:inherit;outline:none;
  }
  input:focus{border-color:var(--acc);box-shadow:0 0 0 3px var(--acc-weak)}
  .hint{color:var(--mut);font-size:13px;margin-top:8px}
  .actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:14px}

  .btn{
    display:inline-flex;align-items:center;justify-content:center;gap:6px;
    height:36px;padding:0 14px;border-radius:6px;border:1px solid transparent;
    font:inherit;font-weight:500;cursor:pointer;text-decoration:none;white-space:nowrap;
  }
  .btn-primary{background:var(--acc);border-color:var(--acc);color:#fff}
  .btn-primary:hover{filter:brightness(.94)}
  .btn-default{background:var(--surface);border-color:var(--brd);color:var(--txt)}
  .btn-default:hover{background:var(--surface-2)}
  .btn-danger{background:var(--surface);border-color:var(--brd);color:var(--bad)}
  .btn-danger:hover{background:var(--bad-weak);border-color:var(--bad)}
  .btn-sm{height:28px;padding:0 10px;font-size:13px}

  table{width:100%;border-collapse:collapse}
  th{
    text-align:left;padding:10px 16px;border-bottom:1px solid var(--brd);
    font-size:12px;font-weight:600;color:var(--mut);text-transform:uppercase;letter-spacing:.04em;white-space:nowrap;
  }
  td{padding:12px 16px;border-bottom:1px solid var(--brd);vertical-align:middle}
  tbody tr:last-child td{border-bottom:0}
  tbody tr:hover{background:var(--surface-2)}
  .num{font-variant-numeric:tabular-nums;white-space:nowrap;color:var(--mut)}
  .col-actions{text-align:right;white-space:nowrap}
  .table-scroll{overflow-x:auto}
  .empty{padding:24px 16px;color:var(--mut);text-align:center}

  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;overflow-wrap:anywhere}
  .name{font-weight:500}
  .mut{color:var(--mut)}

  .status{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:500;
    padding:2px 8px;border-radius:999px;white-space:nowrap}
  .status::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
  .status-ok{color:var(--ok);background:var(--ok-weak)}
  .status-revoked{color:var(--bad);background:var(--bad-weak)}

  .alert{border:1px solid var(--brd);border-left-width:3px;border-radius:6px;padding:12px 14px;margin-bottom:16px;background:var(--surface)}
  .alert-ok{border-left-color:var(--ok)}
  .alert-bad{border-left-color:var(--bad)}
  .alert-title{font-weight:600}
  .alert .hint{margin-top:4px}

  details{margin-top:10px}
  summary{cursor:pointer;color:var(--mut);font-size:13px}
  pre{white-space:pre-wrap;background:var(--surface-2);border:1px solid var(--brd);border-radius:6px;padding:12px;font-size:12px;overflow:auto;margin:8px 0 0}
  a{color:var(--acc)}

  footer{border-top:1px solid var(--brd);padding:16px 0;color:var(--mut);font-size:13px}
</style>
</head>
<body>
  <header>
    <div class="shell header-in">
      <div class="brand">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <path d="M8 1.5 13.5 4v3.8c0 3.2-2.3 5.7-5.5 6.7-3.2-1-5.5-3.5-5.5-6.7V4L8 1.5Z"/>
        </svg>
        OpenVPN
      </div>
      <nav class="nav">
        ${tab("/", "Clientes")}
        ${tab("/connections", "Conexões")}
      </nav>
    </div>
  </header>

  <main class="shell">
    <div class="page-head">
      ${backLink}
      <h1>${esc(heading)}</h1>
      ${subtitle ? `<div class="sub">${subtitle}</div>` : ""}
    </div>
    <div class="grid">
      ${body}
    </div>
  </main>

  <div class="shell">
    <footer>Wizis Intermediações e Negócios Ltda.</footer>
  </div>
</body>
</html>`;
}

// linha da tabela de clientes: marca revogados e oferece deletar só para eles
function clientRow(file, revoked) {
  const cn = cnFromFile(file);
  const ip = ipFromFile(file);
  const isRevoked = revoked.has(cn);

  const status = isRevoked
    ? `<span class="status status-revoked">Revogado</span>`
    : `<span class="status status-ok">Ativo</span>`;

  const del = isRevoked ? `
    <form method="POST" action="/delete" style="display:inline"
          onsubmit="return confirm('Excluir o perfil .ovpn e o IP fixo de ${esc(cn)}?\\n\\nO certificado permanece revogado.')">
      <input type="hidden" name="username" value="${esc(cn)}" />
      <button class="btn btn-danger btn-sm" type="submit">Excluir</button>
    </form>` : "";

  return `
    <tr>
      <td><span class="name">${esc(cn)}</span><div class="mut mono" style="font-size:12px">${esc(file)}</div></td>
      <td class="mono">${esc(ip || "—")}</td>
      <td>${status}</td>
      <td class="col-actions">
        <span class="actions" style="margin:0;justify-content:flex-end">
          <a class="btn btn-default btn-sm" href="/download?file=${encodeURIComponent(file)}">Baixar</a>
          ${del}
        </span>
      </td>
    </tr>`;
}

function clientsTable(files, revoked) {
  if (!files.length) {
    return `<div class="empty">Nenhum cliente emitido.</div>`;
  }
  return `
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Cliente</th>
            <th>IP fixo</th>
            <th>Status</th>
            <th class="col-actions">Ações</th>
          </tr>
        </thead>
        <tbody>${files.map(f => clientRow(f, revoked)).join("")}</tbody>
      </table>
    </div>`;
}

function alert({ ok = true, title, detail = "", details = "" }) {
  return `
    <div class="alert ${ok ? "alert-ok" : "alert-bad"}">
      <div class="alert-title">${title}</div>
      ${detail ? `<div class="hint">${detail}</div>` : ""}
      ${details ? `<details><summary>Detalhes técnicos</summary><pre>${esc(details)}</pre></details>` : ""}
    </div>`;
}

function homeHtml(messageHtml = "") {
  const all = listOvpnFiles();
  const revoked = revokedCNs();
  const recent = all.slice(0, 8);
  const nRevoked = all.filter(f => revoked.has(cnFromFile(f))).length;

  const emitir = `
  <div class="card">
    <div class="card-head"><h2>Emitir cliente</h2></div>
    <div class="card-body">
      <form method="POST" action="/create">
        <label for="cn-novo">Nome do cliente (CN)</label>
        <input id="cn-novo" name="username" placeholder="suporte_01" autocomplete="off" required />
        <div class="hint">Recebe o próximo IP fixo livre e um perfil .ovpn para download.</div>
        <div class="actions">
          <button class="btn btn-primary" type="submit">Emitir perfil</button>
        </div>
      </form>
    </div>
  </div>`;

  const revogar = `
  <div class="card">
    <div class="card-head"><h2>Revogar acesso</h2></div>
    <div class="card-body">
      <form method="POST" action="/revoke">
        <label for="cn-revoga">Nome do cliente (CN)</label>
        <input id="cn-revoga" name="username" placeholder="suporte_01" autocomplete="off" required />
        <div class="hint">O certificado entra na CRL e o cliente deixa de conectar. Sessões abertas caem na próxima renegociação.</div>
        <div class="actions">
          <button class="btn btn-danger" type="submit">Revogar</button>
        </div>
      </form>
    </div>
  </div>`;

  const lista = `
  <div class="card span-all">
    <div class="card-head">
      <h2>Clientes recentes</h2>
      <a class="btn btn-default btn-sm" href="/clients">Ver todos (${all.length})</a>
    </div>
    ${clientsTable(recent, revoked)}
    ${nRevoked ? `<div class="card-foot">${nRevoked} de ${all.length} ${nRevoked === 1 ? "perfil está revogado" : "perfis estão revogados"} e ${nRevoked === 1 ? "pode" : "podem"} ser ${nRevoked === 1 ? "excluído" : "excluídos"}.</div>` : ""}
  </div>`;

  return page({
    title: "Clientes · OpenVPN",
    heading: "Clientes",
    subtitle: "Emissão, revogação e download de perfis.",
    body: (messageHtml ? `<div class="span-all">${messageHtml}</div>` : "") + emitir + revogar + lista,
    active: "/",
  });
}

// ===== Routes =====
app.get("/health", auth, (req, res) => res.json({ ok: true }));

app.get("/", auth, (req, res) => res.type("html").send(homeHtml()));

app.post("/create", auth, async (req, res) => {
  const username = String(req.body.username || "").trim();

  if (!validUsername(username)) {
    return res.status(400).type("html").send(homeHtml(alert({ ok: false, title: "Nome de cliente inválido." })));
  }

  try {
    const { stdout, stderr } = await createClient(username);
    const files = listOvpnForUser(username);

    // pega o mais recente desse usuário
    const newest = files[0];

    const msg = alert({
      title: `Perfil emitido para ${esc(username)}.`,
      detail: newest
        ? `<a href="/download?file=${encodeURIComponent(newest)}">Baixar ${esc(newest)}</a>`
        : "",
      details: stderr,
    });

    return res.type("html").send(homeHtml(msg));
  } catch (err) {
    const code = err?.code ?? "ERR";
    const stdout = err?._stdout || "";
    const stderr = err?._stderr || "";

    const msg = alert({
      ok: false,
      title: "Falha ao emitir o perfil.",
      detail: `Código ${esc(code)}.`,
      details: stderr || stdout || String(err),
    });
    return res.status(500).type("html").send(homeHtml(msg));
  }
});

app.get("/clients", auth, (req, res) => {
  const files = listOvpnFiles();
  const revoked = revokedCNs();
  const nRevoked = files.filter(f => revoked.has(cnFromFile(f))).length;

  const body = `
    <div class="card span-all">
      <div class="card-head">
        <h2>${files.length} ${files.length === 1 ? "perfil" : "perfis"}</h2>
        <a class="btn btn-default btn-sm" href="/">Emitir cliente</a>
      </div>
      ${clientsTable(files, revoked)}
      ${nRevoked ? `<div class="card-foot">${nRevoked} ${nRevoked === 1 ? "revogado" : "revogados"}. Excluir remove o perfil e libera o IP fixo; o certificado segue revogado na CRL.</div>` : ""}
    </div>
  `;

  return res.type("html").send(page({
    title: "Clientes · OpenVPN",
    heading: "Todos os clientes",
    subtitle: "Perfis emitidos, com status de revogação.",
    body,
    active: "/",
    back: { href: "/", label: "Voltar" },
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

// Deleta os artefatos de um cliente JÁ REVOGADO: o(s) .ovpn e o CCD (libera o IP).
// Não toca no PKI: o certificado segue revogado na CRL e no index.txt.
app.post("/delete", auth, (req, res) => {
  const username = String(req.body.username || "").trim();

  if (!validUsername(username)) {
    return res.status(400).type("html").send(homeHtml(alert({ ok: false, title: "Nome de cliente inválido." })));
  }

  if (!revokedCNs().has(username)) {
    return res.status(400).type("html").send(homeHtml(
      alert({
        ok: false,
        title: "Só é possível excluir clientes revogados.",
        detail: `Revogue <span class="mono">${esc(username)}</span> antes de excluir o perfil.`,
      })
    ));
  }

  const removed = [];
  try {
    for (const f of listOvpnFiles().filter(f => cnFromFile(f) === username)) {
      const full = safeJoin(OUT_DIR, f);
      if (full && fs.existsSync(full)) {
        fs.unlinkSync(full);
        removed.push(f);
      }
    }

    const ccd = safeJoin(CCD_DIR, username);
    if (ccd && fs.existsSync(ccd)) {
      fs.unlinkSync(ccd);
      removed.push(`ccd/${username}`);
    }
  } catch (err) {
    return res.status(500).type("html").send(homeHtml(
      alert({ ok: false, title: "Falha ao excluir.", details: maskPaths(String(err)) })
    ));
  }

  const msg = removed.length
    ? alert({
        title: `Perfil de ${esc(username)} excluído.`,
        detail: `Removido: ${removed.map(r => `<span class="mono">${esc(r)}</span>`).join(", ")}. O certificado continua revogado na CRL.`,
      })
    : alert({ ok: false, title: `Nada a remover para ${esc(username)}.` });

  return res.type("html").send(homeHtml(msg));
});

app.post("/revoke", auth, async (req, res) => {
  const username = String(req.body.username || "").trim();

  if (!validUsername(username)) {
    return res.status(400).type("html").send(homeHtml(alert({ ok: false, title: "Nome de cliente inválido." })));
  }

  try {
    await revokeClient(username);

    const note = alert({
      title: `${esc(username)} revogado.`,
      detail: CRL_DEPLOY
        ? "A CRL foi atualizada e aplicada no OpenVPN. Novas conexões desse certificado são recusadas; sessões abertas caem na próxima renegociação."
        : "A CRL foi atualizada, mas <b>OVPN_CRL_DEPLOY</b> não está definido — ela não foi aplicada no OpenVPN e a revogação não terá efeito.",
    });
    return res.type("html").send(homeHtml(note));
  } catch (err) {
    const code = err?.code ?? "ERR";
    const stdout = err?._stdout || "";
    const stderr = err?._stderr || "";

    const msg = alert({
      ok: false,
      title: "Falha ao revogar.",
      detail: `Código ${esc(code)}.`,
      details: stderr || stdout || String(err),
    });
    return res.status(500).type("html").send(homeHtml(msg));
  }
});

// ===== OpenVPN Connections (parse /run/openvpn/server.status) =====
app.get("/connections", auth, (req, res) => {
  const statusFile = process.env.OPENVPN_STATUS || "/run/openvpn/server.status";

  if (!fs.existsSync(statusFile)) {
    return res.status(500).type("html").send(page({
      title: "Conexões · OpenVPN",
      heading: "Conexões",
      active: "/connections",
      back: { href: "/", label: "Voltar" },
      body: `<div class="span-all">${alert({
        ok: false,
        title: "Arquivo de status do OpenVPN não encontrado.",
        detail: `Esperado em <span class="mono">${esc(statusFile)}</span>. Monte no container o arquivo indicado pela diretiva <b>status</b> do server.conf.`,
      })}</div>`,
    }));
  }

  const txt = fs.readFileSync(statusFile, "utf8");
  const lines = txt.split("\n").map(l => l.replace(/\r$/, "")).filter(l => l.trim());

  let updated = "";
  let clients = [];

  const isV3 = lines.some(l => l.startsWith("CLIENT_LIST\t") || l.startsWith("HEADER\tCLIENT_LIST\t"));

  if (isV3) {
    // status-version 3: campos separados por TAB, com prefixo por linha
    const timeLine = lines.find(l => l.startsWith("TIME\t"));
    updated = timeLine ? timeLine.split("\t")[1] || "" : "";

    // o HEADER descreve a ordem das colunas do CLIENT_LIST
    const headerLine = lines.find(l => l.startsWith("HEADER\tCLIENT_LIST\t"));
    const cols = headerLine ? headerLine.split("\t").slice(2) : [];
    const col = (row, name, fallbackIdx) => {
      const i = cols.indexOf(name);
      return (i >= 0 ? row[i] : row[fallbackIdx]) || "";
    };

    clients = lines
      .filter(l => l.startsWith("CLIENT_LIST\t"))
      .map(l => {
        const row = l.split("\t").slice(1);
        return {
          name:    col(row, "Common Name", 0),
          real:    col(row, "Real Address", 1),
          virtual: col(row, "Virtual Address", 2),
          rx:      col(row, "Bytes Received", 4),
          tx:      col(row, "Bytes Sent", 5),
          since:   col(row, "Connected Since", 6),
        };
      });
  } else {
    // status-version 1/2: CSV, com "Updated," e marcador "ROUTING TABLE"
    const updatedLine = lines.find(l => l.startsWith("Updated,"));
    updated = updatedLine ? updatedLine.split(",").slice(1).join(",") : "";

    const idxClientHeader = lines.findIndex(l => l.startsWith("Common Name,Real Address"));
    const idxRouting = lines.findIndex(l => l.trim() === "ROUTING TABLE");

    const clientRows = (idxClientHeader >= 0)
      ? lines.slice(idxClientHeader + 1, idxRouting >= 0 ? idxRouting : lines.length)
      : [];

    clients = clientRows
      .filter(l => l.includes(","))
      .map(l => {
        const [name, real, rx, tx, since] = l.split(",");
        return { name, real, virtual: "", rx, tx, since };
      });
  }

  const rows = clients.map(c => `
    <tr>
      <td><span class="name">${esc(c.name)}</span></td>
      <td class="mono">${esc(c.virtual || "—")}</td>
      <td class="mono">${esc(c.real)}</td>
      <td class="num">${esc(c.since)}</td>
      <td class="num">${esc(fmtBytes(c.rx))}</td>
      <td class="num">${esc(fmtBytes(c.tx))}</td>
    </tr>`).join("");

  const body = `
    <div class="card span-all">
      <div class="card-head">
        <h2>${clients.length} ${clients.length === 1 ? "cliente conectado" : "clientes conectados"}</h2>
        <span class="actions" style="margin:0">
          <span class="mut">Atualizado às ${esc(updated || "—")}</span>
          <a class="btn btn-default btn-sm" href="/connections">Atualizar</a>
        </span>
      </div>
      ${clients.length ? `
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Cliente</th>
                <th>IP na VPN</th>
                <th>Origem</th>
                <th>Conectado desde</th>
                <th>Recebido</th>
                <th>Enviado</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>` : `<div class="empty">Nenhum cliente conectado.</div>`}
    </div>
  `;

  return res.type("html").send(page({
    title: "Conexões · OpenVPN",
    heading: "Conexões",
    subtitle: "Sessões abertas no servidor OpenVPN.",
    body,
    active: "/connections",
    back: { href: "/", label: "Voltar" },
  }));
});

// ===== Start Server =====
app.listen(PORT, "0.0.0.0", () => {
  console.log(`ovpn-ui on http://0.0.0.0:${PORT}`);
});
