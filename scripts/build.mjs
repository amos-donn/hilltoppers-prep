/* Copies the static topping files into dist/ for hosting deploys.
   No dependencies — plain Node, exits when done. */

import { copyFile, mkdir, rm } from "node:fs/promises";

const FILES = ["index.html", "style.css", "script.js", "resize.js", "favicon.svg"];

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });

for (const file of FILES) {
  await copyFile(file, `dist/${file}`);
}

console.log(`build ok: dist/ <- ${FILES.join(", ")}`);
