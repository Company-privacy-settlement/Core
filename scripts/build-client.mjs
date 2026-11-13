import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
mkdirSync("dist/client", { recursive: true });
execFileSync(process.execPath, ['scripts/browser-poseidon.mjs', '--check'], { stdio: 'inherit' });
await build({
  entryPoints: ["sdk/client/index.ts"],
  outfile: "dist/client/index.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  metafile: true,
}).then((result) => {
  if (
    Object.keys(result.metafile.inputs).some(
      (f) => !f.startsWith("sdk/client/"),
    )
  )
    throw new Error("Browser build imported a non-client module");
});
execFileSync(
  process.execPath,
  ["node_modules/typescript/bin/tsc", "-p", "tsconfig.client.json"],
  { stdio: "inherit" },
);
const sha = (b) => createHash("sha256").update(b).digest("hex");
const files = Object.fromEntries(
  readdirSync("dist/client")
    .filter((f) => f.endsWith(".js") || f.endsWith(".d.ts"))
    .sort()
    .map((f) => [f, sha(readFileSync(`dist/client/${f}`))]),
);
const sources = Object.fromEntries(
  readdirSync("sdk/client")
    .filter((f) => f.endsWith(".ts"))
    .sort()
    .map((f) => [f, sha(readFileSync(`sdk/client/${f}`))]),
);
writeFileSync(
  "dist/client/manifest.json",
  JSON.stringify(
    { format: "core-browser-client-v1", files, sources },
    null,
    2,
  ) + "\n",
);
console.log("Browser client built with no Node or external runtime imports");
