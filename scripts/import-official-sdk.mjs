import fs from "fs";
import path from "path";
import process from "process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const sourceRoot = process.argv[2];

if (!sourceRoot) {
  console.error("Usage: node scripts/import-official-sdk.mjs /absolute/path/to/CubismSdkForWeb");
  process.exit(1);
}

const absoluteSource = path.resolve(sourceRoot);
const coreDir = path.join(absoluteSource, "Core");
const frameworkDir = path.join(absoluteSource, "Framework");
const vendorDir = path.join(root, "vendor/live2d-sdk");

function copyDir(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  fs.cpSync(source, destination, { recursive: true, force: true });
}

if (!fs.existsSync(coreDir)) {
  console.error(`Missing Core directory in ${absoluteSource}`);
  process.exit(1);
}

if (!fs.existsSync(frameworkDir)) {
  console.error(`Missing Framework directory in ${absoluteSource}`);
  process.exit(1);
}

copyDir(coreDir, path.join(vendorDir, "Core"));
copyDir(frameworkDir, path.join(vendorDir, "Framework"));

console.log("Imported official Live2D SDK directories:");
console.log(`- Core -> ${path.join(vendorDir, "Core")}`);
console.log(`- Framework -> ${path.join(vendorDir, "Framework")}`);
console.log("");
console.log("Next suggested step:");
console.log("1. cd apps/live2d-desktop/vendor/live2d-sdk/Framework");
console.log("2. npm install");
console.log("3. npm run build");
