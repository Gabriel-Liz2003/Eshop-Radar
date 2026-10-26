import { spawnSync } from "node:child_process";

const queueName = "eshop-br-scan";

function run(args, { allowExists = false } = {}) {
  const cmd = spawnSync("npx", ["wrangler", ...args], {
    stdio: "pipe",
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  const combined = `${cmd.stdout ?? ""}\n${cmd.stderr ?? ""}`;
  if (cmd.stdout) process.stdout.write(cmd.stdout);
  if (cmd.stderr) process.stderr.write(cmd.stderr);
  if (cmd.status !== 0) {
    if (allowExists && /already exists|already been created|queue.*exists/i.test(combined)) return;
    process.exit(cmd.status ?? 1);
  }
}

console.log("=== eShop BR Alert v1.6.1 — migração para Cloudflare Queues ===\n");
console.log("1/2 Criando a fila (se ainda não existir)...");
run(["queues", "create", queueName], { allowExists: true });
console.log("\n2/2 Publicando o Worker com producer + consumer...");
run(["deploy"]);
console.log("\nPronto. O Cron agora só enfileira o scan; o trabalho pesado roda no Queue Consumer.");
console.log("Isso evita o limite de 10 ms de CPU do Workers Free sem mudar o custo: R$ 0.");
