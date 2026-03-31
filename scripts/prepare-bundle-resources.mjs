import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const sourceProtocolRoot = path.resolve(projectRoot, "..", "devflow-protocol");
const buildResourcesRoot = path.join(projectRoot, "build-resources");
const bundleRoot = path.join(buildResourcesRoot, "bundle");
const targetProtocolRoot = path.join(bundleRoot, "devflow-protocol");
const runtimeToolsRoot = path.join(buildResourcesRoot, "runtime-tools");
const runtimeToolsBinRoot = path.join(runtimeToolsRoot, "bin");
const toolSources = {
  bun: process.env.BUN_PATH || "/Users/weirwei/.bun/bin/bun",
  jq: process.env.JQ_PATH || "/usr/bin/jq",
};

function ensureExists(targetPath, label) {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`${label} not found: ${targetPath}`);
  }
}

function copyDir(source, target) {
  fs.cpSync(source, target, {
    recursive: true,
    force: true,
    filter(sourcePath) {
      const baseName = path.basename(sourcePath);
      if (baseName === ".git") return false;
      if (baseName === ".serena") return false;
      if (baseName === "node_modules") return false;
      if (baseName === ".devflow-plugin-state") return false;
      return true;
    },
  });
}

function copyTool(name, sourcePath) {
  ensureExists(sourcePath, `${name} binary`);
  fs.mkdirSync(runtimeToolsBinRoot, { recursive: true });
  const targetPath = path.join(runtimeToolsBinRoot, name);
  fs.copyFileSync(sourcePath, targetPath);
  fs.chmodSync(targetPath, 0o755);
  return targetPath;
}

function main() {
  ensureExists(sourceProtocolRoot, "devflow-protocol source");
  ensureExists(path.join(sourceProtocolRoot, "src", "server.ts"), "devflow-protocol server");
  fs.rmSync(targetProtocolRoot, { recursive: true, force: true });
  fs.rmSync(runtimeToolsRoot, { recursive: true, force: true });
  fs.mkdirSync(bundleRoot, { recursive: true });

  copyDir(sourceProtocolRoot, targetProtocolRoot);
  const copiedTools = Object.entries(toolSources).map(([name, sourcePath]) =>
    `${name} -> ${copyTool(name, sourcePath)}`,
  );

  console.log(`[prepare-bundle-resources] copied devflow-protocol -> ${targetProtocolRoot}`);
  console.log(`[prepare-bundle-resources] copied runtime tools: ${copiedTools.join(", ")}`);
}

main();
