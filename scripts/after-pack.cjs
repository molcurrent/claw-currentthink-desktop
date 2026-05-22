const fs = require("node:fs");
const path = require("node:path");

function findAppBundle(appOutDir) {
  return fs.readdirSync(appOutDir)
    .find((entry) => entry.endsWith(".app"));
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appBundle = findAppBundle(context.appOutDir);
  if (!appBundle) return;

  const resourcesDir = path.join(context.appOutDir, appBundle, "Contents", "Resources");
  const binDir = path.join(resourcesDir, "bin");
  if (!fs.existsSync(binDir)) return;

  const outDirName = path.basename(context.appOutDir);
  const isX64 = outDirName.includes("x64");
  const isArm64 = outDirName.includes("arm64");
  const targetArchDir = isX64 ? "darwin-x64" : isArm64 ? "darwin-arm64" : "";
  if (!targetArchDir) return;

  const source = path.join(binDir, targetArchDir, "claw");
  const destinationDir = path.join(binDir, "darwin");
  const destination = path.join(destinationDir, "claw");
  fs.mkdirSync(destinationDir, { recursive: true });
  fs.copyFileSync(source, destination);
  fs.chmodSync(destination, 0o755);
  fs.rmSync(path.join(binDir, "darwin-x64"), { recursive: true, force: true });
  fs.rmSync(path.join(binDir, "darwin-arm64"), { recursive: true, force: true });
};
