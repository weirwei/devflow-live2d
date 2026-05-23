import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const outRoot = path.join(projectRoot, "build-resources", "tauri-web");

function copyDir(source, target) {
  fs.cpSync(source, target, {
    recursive: true,
    force: true,
    filter(sourcePath) {
      const base = path.basename(sourcePath);
      return base !== ".DS_Store";
    },
  });
}

function replaceInFile(filePath, replacements) {
  let text = fs.readFileSync(filePath, "utf-8");
  for (const [from, to] of replacements) {
    text = text.replaceAll(from, to);
  }
  fs.writeFileSync(filePath, text);
}

fs.rmSync(outRoot, { recursive: true, force: true });
fs.mkdirSync(outRoot, { recursive: true });

copyDir(path.join(projectRoot, "ui"), outRoot);
copyDir(path.join(projectRoot, "src"), path.join(outRoot, "src"));
copyDir(path.join(projectRoot, "assets"), path.join(outRoot, "assets"));
copyDir(path.join(projectRoot, "official-demo-runtime"), path.join(outRoot, "official-demo-runtime"));

replaceInFile(path.join(outRoot, "app.js"), [
  ["../src/", "./src/"],
  ["import(`../${config.adapterScript}`)", "import(`./${config.adapterScript}`)"],
]);

replaceInFile(path.join(outRoot, "src", "live2d-config.js"), [
  ["fetch(`../${path}`)", "fetch(`./${path}`)"],
]);

for (const adapterPath of [
  path.join(outRoot, "assets", "live2d", "adapters", "official-demo-runtime.js"),
  path.join(outRoot, "assets", "live2d", "adapters", "official-demo-preview.js"),
]) {
  replaceInFile(adapterPath, [
    ["fetch(`../${relativePath}`", "fetch(`./${relativePath}`"],
  ]);
}

console.log(`[prepare-tauri-web] wrote ${outRoot}`);
