import fs from "fs";
import path from "path";
import process from "process";

const root = process.cwd();
const manifestPath = path.join(root, "assets/live2d/manifest.json");
const cubismCoreCandidates = [
  "vendor/live2d-sdk/Core/live2dcubismcore.js",
  "official-demo-runtime/dist/Core/live2dcubismcore.js",
];
const cubismFrameworkCandidates = [
  "vendor/live2d-sdk/Framework",
  "official-demo-runtime/dist/Framework",
];

function log(status, message) {
  console.log(`${status} ${message}`);
}

if (!fs.existsSync(manifestPath)) {
  log("WARN", "No assets/live2d/manifest.json found.");
  log("INFO", "The desktop app will fall back to the mock avatar until you add a Live2D manifest.");
  process.exit(0);
}

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
} catch (error) {
  log("FAIL", `Could not parse manifest.json: ${error.message}`);
  process.exit(1);
}

const missing = [];
const model = manifest?.model || {};
const sdk = manifest?.sdk || {};

if (!sdk.adapterScript) {
  missing.push("sdk.adapterScript");
}

if (!model.modelJson) {
  missing.push("model.modelJson");
}

if (!model.basePath) {
  missing.push("model.basePath");
}

if (missing.length > 0) {
  log("FAIL", `Manifest is missing required fields: ${missing.join(", ")}`);
  process.exit(1);
}

const adapterPath = path.join(root, sdk.adapterScript);
const modelJsonPath = path.join(root, model.basePath, model.modelJson);

if (!fs.existsSync(adapterPath)) {
  log("FAIL", `Adapter script not found: ${sdk.adapterScript}`);
  process.exit(1);
}

if (!fs.existsSync(modelJsonPath)) {
  log("FAIL", `Model JSON not found: ${path.relative(root, modelJsonPath)}`);
  process.exit(1);
}

log("PASS", "Live2D manifest looks usable.");
log("INFO", `Adapter: ${sdk.adapterScript}`);
log("INFO", `Model JSON: ${path.relative(root, modelJsonPath)}`);

const cubismCorePath = cubismCoreCandidates.find((candidate) =>
  fs.existsSync(path.join(root, candidate)),
);
const cubismFrameworkPath = cubismFrameworkCandidates.find((candidate) =>
  fs.existsSync(path.join(root, candidate)),
);

if (cubismCorePath) {
  log("INFO", `Official Core detected: ${cubismCorePath}`);
} else {
  log(
    "WARN",
    `Official Cubism Core not found under ${cubismCoreCandidates.join(" or ")}`,
  );
}

if (cubismFrameworkPath) {
  log("INFO", `Official Framework detected: ${cubismFrameworkPath}`);
} else {
  const officialDemoCoreOnly = cubismCorePath?.startsWith("official-demo-runtime/");
  if (officialDemoCoreOnly) {
    log("INFO", "Official Framework is bundled into official-demo-runtime/dist/main.js");
  } else {
    log("WARN", `Official Framework not found under ${cubismFrameworkCandidates.join(" or ")}`);
  }
}
