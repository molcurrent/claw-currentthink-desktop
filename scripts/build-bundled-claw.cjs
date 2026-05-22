const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const rustDir = path.join(root, "vendor", "claw-code", "rust");
const binDir = path.join(root, "bin");

const targetMap = new Map([
  ["x86_64-apple-darwin", { platform: "darwin", arch: "x64", exe: "claw" }],
  ["aarch64-apple-darwin", { platform: "darwin", arch: "arm64", exe: "claw" }],
  ["x86_64-unknown-linux-gnu", { platform: "linux", arch: "x64", exe: "claw" }],
  ["x86_64-pc-windows-msvc", { platform: "win32", arch: "x64", exe: "claw.exe" }],
]);

function hostTarget() {
  if (process.platform === "darwin" && process.arch === "arm64") return "aarch64-apple-darwin";
  if (process.platform === "darwin" && process.arch === "x64") return "x86_64-apple-darwin";
  if (process.platform === "linux" && process.arch === "x64") return "x86_64-unknown-linux-gnu";
  if (process.platform === "win32" && process.arch === "x64") return "x86_64-pc-windows-msvc";
  throw new Error(`Unsupported build host: ${process.platform} ${process.arch}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || root,
    env: { ...process.env, ...(options.env || {}) },
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

function copyBinary(target) {
  const meta = targetMap.get(target);
  if (!meta) throw new Error(`No bundled binary mapping for Rust target ${target}`);

  const releaseDir = path.join(rustDir, "target", target, "release");
  const source = path.join(releaseDir, meta.exe);
  if (!fs.existsSync(source)) {
    throw new Error(`Built claw binary not found: ${source}`);
  }

  const destinationDir = path.join(binDir, `${meta.platform}-${meta.arch}`);
  fs.mkdirSync(destinationDir, { recursive: true });
  const destination = path.join(destinationDir, meta.exe);
  fs.copyFileSync(source, destination);
  if (meta.platform !== "win32") fs.chmodSync(destination, 0o755);
  console.log(`Bundled ${target} -> ${path.relative(root, destination)}`);
}

function parseTargets() {
  const raw = process.env.CLAW_BUILD_TARGETS || "";
  const targets = raw.split(",").map((item) => item.trim()).filter(Boolean);
  return targets.length ? targets : [hostTarget()];
}

if (!fs.existsSync(path.join(rustDir, "Cargo.toml"))) {
  throw new Error("Missing vendored Claw Code Rust workspace.");
}

const targets = parseTargets();
fs.mkdirSync(binDir, { recursive: true });

for (const target of targets) {
  if (!targetMap.has(target)) {
    throw new Error(`Unsupported CLAW_BUILD_TARGETS entry: ${target}`);
  }
  run("cargo", ["build", "--release", "--bin", "claw", "--target", target], { cwd: rustDir });
  copyBinary(target);
}

