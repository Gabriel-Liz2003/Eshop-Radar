import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import webpush from "web-push";

const SETUP_FILE = ".eshop-setup.json";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    shell: process.platform === "win32",
    ...options,
  });
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  return result;
}

function loadOrCreateSecrets() {
  if (existsSync(SETUP_FILE)) {
    const existing = JSON.parse(readFileSync(SETUP_FILE, "utf8"));
    if (existing.vapidPublicKey && existing.vapidPrivateKey && existing.adminToken) return existing;
    const vapid = webpush.generateVAPIDKeys();
    const upgraded = {
      ...existing,
      adminToken: existing.adminToken ?? randomBytes(24).toString("hex"),
      vapidPublicKey: existing.vapidPublicKey ?? vapid.publicKey,
      vapidPrivateKey: existing.vapidPrivateKey ?? vapid.privateKey,
    };
    writeFileSync(SETUP_FILE, JSON.stringify(upgraded, null, 2));
    return upgraded;
  }

  const vapid = webpush.generateVAPIDKeys();
  const data = {
    adminToken: randomBytes(24).toString("hex"),
    vapidPublicKey: vapid.publicKey,
    vapidPrivateKey: vapid.privateKey,
  };
  writeFileSync(SETUP_FILE, JSON.stringify(data, null, 2));
  return data;
}

console.log("\n=== eShop BR Alert — configuração automática ===\n");
console.log("1/4 Verificando login na Cloudflare...");
let whoami = spawnSync("npx", ["wrangler", "whoami"], {
  encoding: "utf8",
  shell: process.platform === "win32",
});
if (whoami.status !== 0 || /not authenticated|not logged/i.test(`${whoami.stdout}\n${whoami.stderr}`)) {
  console.log("Abrindo o login seguro da Cloudflare por código de dispositivo. Autorize no navegador e volte ao terminal.");
  run("npx", ["wrangler", "login", "--device"], { stdio: "inherit" });
}

const secrets = loadOrCreateSecrets();

console.log("\n2/4 Fazendo o primeiro deploy e criando o D1 automaticamente...");
const deploy = run("npx", ["wrangler", "deploy"], { stdio: ["inherit", "pipe", "pipe"] });
process.stdout.write(deploy.stdout ?? "");
process.stderr.write(deploy.stderr ?? "");
const combined = `${deploy.stdout ?? ""}\n${deploy.stderr ?? ""}`;
const workerUrl = combined.match(/https:\/\/[^\s]+\.workers\.dev\/?/i)?.[0]?.replace(/\/$/, "") ?? null;

console.log("\n3/4 Gravando os segredos Web Push e do painel...");
run("npx", ["wrangler", "secret", "put", "VAPID_PUBLIC_KEY"], {
  input: `${secrets.vapidPublicKey}\n`,
  stdio: ["pipe", "inherit", "inherit"],
});
run("npx", ["wrangler", "secret", "put", "VAPID_PRIVATE_KEY"], {
  input: `${secrets.vapidPrivateKey}\n`,
  stdio: ["pipe", "inherit", "inherit"],
});
run("npx", ["wrangler", "secret", "put", "ADMIN_TOKEN"], {
  input: `${secrets.adminToken}\n`,
  stdio: ["pipe", "inherit", "inherit"],
});

console.log("\n4/4 Pronto.\n");
if (workerUrl) {
  console.log(`Status público: ${workerUrl}/status`);
  console.log(`Painel privado: ${workerUrl}/admin?token=${secrets.adminToken}`);
} else {
  console.log("O Wrangler não expôs a URL no formato esperado. Veja a URL *.workers.dev no resultado do deploy acima.");
  console.log(`Depois abra: https://SUA-URL.workers.dev/admin?token=${secrets.adminToken}`);
}
console.log("\nNo painel, toque em 'Ativar notificações neste celular'. Não é necessário instalar ntfy.\n");
