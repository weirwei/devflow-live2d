import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const sourceProtocolRoot = path.resolve(projectRoot, "..", "devflow-protocol-go");
const buildResourcesRoot = path.join(projectRoot, "build-resources");
const bundleRoot = path.join(buildResourcesRoot, "bundle");
const targetProtocolRoot = path.join(bundleRoot, "devflow-protocol-go");

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

function main() {
  const protocolBinary = path.join(sourceProtocolRoot, "bin", "devflow-protocol");
  const pluginDir = path.join(sourceProtocolRoot, "claude-plugin");

  ensureExists(sourceProtocolRoot, "devflow-protocol-go source");
  ensureExists(protocolBinary, "devflow-protocol binary");
  ensureExists(pluginDir, "claude-plugin directory");

  fs.rmSync(targetProtocolRoot, { recursive: true, force: true });
  fs.mkdirSync(bundleRoot, { recursive: true });

  // Copy binary
  const targetBinDir = path.join(targetProtocolRoot, "bin");
  fs.mkdirSync(targetBinDir, { recursive: true });
  const targetBinary = path.join(targetBinDir, "devflow-protocol");
  fs.copyFileSync(protocolBinary, targetBinary);
  fs.chmodSync(targetBinary, 0o755);

  const tauriMacArm64Binary = path.join(targetBinDir, "devflow-protocol-aarch64-apple-darwin");
  fs.copyFileSync(protocolBinary, tauriMacArm64Binary);
  fs.chmodSync(tauriMacArm64Binary, 0o755);

  // Copy claude-plugin
  copyDir(pluginDir, path.join(targetProtocolRoot, "claude-plugin"));

  console.log(`[prepare-bundle-resources] copied devflow-protocol binary -> ${targetBinary}`);
  console.log(`[prepare-bundle-resources] copied Tauri sidecar binary -> ${tauriMacArm64Binary}`);
  console.log(`[prepare-bundle-resources] copied claude-plugin -> ${path.join(targetProtocolRoot, "claude-plugin")}`);
}

main();
