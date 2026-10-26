import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { brotliDecompressSync } from "node:zlib";

const parts = [
  ".repair/index.ts.br.b64.00",
  ".repair/index.ts.br.b64.01",
];

const encoded = parts.map((path) => readFileSync(path, "utf8").trim()).join("");
const source = brotliDecompressSync(Buffer.from(encoded, "base64"));
const hash = createHash("sha256").update(source).digest("hex");
const expectedHash = "230ba11d42c67eb4ca94612099eb650750e0b7b3ff6100be4595ec8a868394e8";

if (hash !== expectedHash) {
  throw new Error(`Reconstructed src/index.ts hash mismatch: ${hash}`);
}

writeFileSync("src/index.ts", source);
console.log(`Reconstructed src/index.ts (${source.length} bytes, sha256 ${hash})`);
