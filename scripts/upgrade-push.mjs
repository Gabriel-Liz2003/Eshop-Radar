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

if (!existsSync(SETUP_FILE)) {
  console.error("Arquivo .eshop-setup.json não encontrado. Rode este upgrade dentro da pasta já configurada do projeto.");
  process.exit(1);
}

const current = JSON.parse(readFileSync(SETUP_FILE, "utf8"));
const vapid = current.vapidPublicKey && current.vapidPrivateKey
  ? { publicKey: current.vapidPublicKey, privateKey: current.vapidPrivateKey }
  : webpush.generateVAPIDKeys();

const adminToken = randomBytes(24).toString("hex");
const next = {
  ...current,
  adminToken,
  vapidPublicKey: vapid.publicKey,
  vapidPrivateKey: vapid.privateKey,
};
writeFileSync(SETUP_FILE, JSON.stringify(next, null, 2));

console.log("\n=== eShop BR Alert v1.4 — migrando para Web Push ===\n");
console.log("1/4 Gravando chave pública VAPID...");
run("npx", ["wrangler", "secret", "put", "VAPID_PUBLIC_KEY"], {
  input: `${vapid.publicKey}\n`,
  stdio: ["pipe", "inherit", "inherit"],
});

console.log("\n2/4 Gravando chave privada VAPID...");
run("npx", ["wrangler", "secret", "put", "VAPID_PRIVATE_KEY"], {
  input: `${vapid.privateKey}\n`,
  stdio: ["pipe", "inherit", "inherit"],
});

console.log("\n3/4 Rotacionando token administrativo...");
run("npx", ["wrangler", "secret", "put", "ADMIN_TOKEN"], {
  input: `${adminToken}\n`,
  stdio: ["pipe", "inherit", "inherit"],
});

console.log("\n4/4 Publicando a versão Web Push...");
const deploy = run("npx", ["wrangler", "deploy"], { stdio: ["inherit", "pipe", "pipe"] });
process.stdout.write(deploy.stdout ?? "");
process.stderr.write(deploy.stderr ?? "");
const combined = `${deploy.stdout ?? ""}\n${deploy.stderr ?? ""}`;
const workerUrl = combined.match(/https:\/\/[^\s]+\.workers\.dev\/?/i)?.[0]?.replace(/\/$/, "") ?? null;

console.log("\n✅ Migração concluída.");
console.log("O ntfy não é mais necessário para este projeto.");
if (workerUrl) {
  console.log(`Novo painel privado: ${workerUrl}/admin?token=${adminToken}`);
} else {
  console.log(`Abra seu Worker em /admin?token=${adminToken}`);
}
console.log("\nNo painel, toque em 'Ativar notificações neste celular', permita notificações e depois use 'Enviar notificação de teste'.\n");
