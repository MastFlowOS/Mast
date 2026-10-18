import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateSupabaseEnv } from "./validate-env.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

// Step 0: Validate Supabase environment configuration before desktop build
console.log("[stage-worker] Validating Supabase client build configuration...");
const envCheck = validateSupabaseEnv(rootDir);
if (!envCheck.valid) {
  console.error(`\x1b[31m[stage-worker] ERROR: Desktop build blocked by invalid Supabase configuration:\x1b[0m`);
  for (const issue of envCheck.issues) {
    console.error(`  \x1b[31m•\x1b[0m ${issue}`);
  }
  console.error(`\x1b[33mEnsure VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are valid production keys in .env or .env.local.\x1b[0m`);
  process.exit(1);
}
console.log(`\x1b[32m[stage-worker] Supabase configuration verified (URL: ${envCheck.url})\x1b[0m`);

const workerDistDir = path.join(rootDir, "dist-worker", "mast-desktop-worker");
const workerExePath = path.join(workerDistDir, "mast-desktop-worker.exe");
const workerInternalDir = path.join(workerDistDir, "_internal");

const tauriBinDir = path.join(rootDir, "src-tauri", "bin");
const tauriTargetDir = path.join(tauriBinDir, "mast-desktop-worker");

console.log("[stage-worker] Checking PyInstaller worker build...");

if (!fs.existsSync(workerExePath)) {
  console.error(`\x1b[31m[stage-worker] Error: Packaged worker executable not found at:\n  ${workerExePath}\x1b[0m`);
  console.error("\x1b[33mRun 'npm run build:worker' to package the Python worker with PyInstaller before staging.\x1b[0m");
  process.exit(1);
}

if (!fs.existsSync(workerInternalDir)) {
  console.error(`\x1b[31m[stage-worker] Error: Required '_internal' runtime directory not found at:\n  ${workerInternalDir}\x1b[0m`);
  process.exit(1);
}

console.log(`[stage-worker] Source worker found at: ${workerDistDir}`);
console.log(`[stage-worker] Staging into Tauri resource directory: ${tauriTargetDir}`);

if (fs.existsSync(tauriTargetDir)) {
  fs.rmSync(tauriTargetDir, { recursive: true, force: true });
}
fs.mkdirSync(tauriTargetDir, { recursive: true });

// Recursively copy worker distribution into src-tauri/bin/mast-desktop-worker/
fs.cpSync(workerDistDir, tauriTargetDir, { recursive: true });

const targetExe = path.join(tauriTargetDir, "mast-desktop-worker.exe");
const targetInternal = path.join(tauriTargetDir, "_internal");

if (!fs.existsSync(targetExe) || !fs.existsSync(targetInternal)) {
  console.error("\x1b[31m[stage-worker] Verification failed: Staged worker files missing.\x1b[0m");
  process.exit(1);
}

// Calculate total staged size
function getDirSize(dirPath) {
  let size = 0;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      size += getDirSize(full);
    } else if (entry.isFile()) {
      size += fs.statSync(full).size;
    }
  }
  return size;
}

const totalMb = (getDirSize(tauriTargetDir) / (1024 * 1024)).toFixed(1);
console.log(`\x1b[32m[stage-worker] Worker successfully staged for Tauri bundle (${totalMb} MB at ${tauriTargetDir})\x1b[0m`);
