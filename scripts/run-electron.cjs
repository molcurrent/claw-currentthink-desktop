const { spawn } = require("node:child_process");
const path = require("node:path");

const electronPath = require("electron");
const args = process.argv.slice(2);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, args.length > 0 ? args : ["."], {
  stdio: "inherit",
  env,
  cwd: path.resolve(__dirname, ".."),
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
