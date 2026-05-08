import { spawn, type ChildProcess } from "node:child_process";
import { loadConfig } from "./config.js";

type ChildName = "api" | "web";

interface ChildSpec {
  name: ChildName;
  command: string;
  args: string[];
}

const children: ChildProcess[] = [];
let shuttingDown = false;
const config = loadConfig({ requireDiscord: false });

const specs: ChildSpec[] = [
  { name: "api", command: "tsx", args: ["src/excalidrawServer.ts"] },
  { name: "web", command: "vite", args: [] },
];

console.log("Starting Arc-Tech Excalidraw MVP...");
console.log(`API: http://${config.excalidrawHost}:${config.excalidrawPort}`);
console.log("UI:  http://127.0.0.1:5173");

for (const spec of specs) {
  const child = spawn(spec.command, spec.args, {
    env: process.env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  children.push(child);

  child.on("error", (error) => {
    if (!shuttingDown) {
      console.error(`Failed to start Excalidraw ${spec.name}:`, error);
      shutdown(1);
    }
  });

  child.on("exit", (code, signal) => {
    if (!shuttingDown) {
      if (code && code !== 0) {
        console.error(`Excalidraw ${spec.name} exited with code ${code}.`);
      } else if (signal) {
        console.error(`Excalidraw ${spec.name} exited from ${signal}.`);
      }
      shutdown(code && code !== 0 ? code : 0);
    }
  });
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

function shutdown(exitCode: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  }
  setTimeout(() => process.exit(exitCode), 300).unref();
}
