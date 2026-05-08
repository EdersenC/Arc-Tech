#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const bridgeRoot = path.resolve(process.cwd(), ".codex-bridge");
const requestsDir = path.join(bridgeRoot, "requests");
const responsesDir = path.join(bridgeRoot, "responses");
const eventsFile = path.join(bridgeRoot, "events.jsonl");

async function main(): Promise<void> {
  const [, , namespace, action, ...args] = process.argv;
  if (namespace !== "orchestrate") {
    usage();
    process.exitCode = 1;
    return;
  }
  await ensureBridge();

  if (action === "status") {
    console.log(`arcctl bridge: ${bridgeRoot}`);
    console.log("status: ready");
    return;
  }

  if (action === "propose-plan" || action === "spawn") {
    const file = readFlag(args, "--file");
    if (!file) {
      throw new Error(`${action} requires --file <fleet-plan.json>.`);
    }
    const planJson = await fs.readFile(path.resolve(process.cwd(), file), "utf8");
    const request = {
      type: action === "propose-plan" ? "orchestration.propose_plan" : "orchestration.spawn",
      file: path.resolve(process.cwd(), file),
      plan: JSON.parse(planJson),
      createdAt: new Date().toISOString(),
    };
    await writeRequest(request.type, request);
    await writeEvent(request);
    console.log(`queued ${request.type}`);
    return;
  }

  if (action === "report-agent-done") {
    const agentId = readFlag(args, "--agent-id");
    const summaryFile = readFlag(args, "--summary-file");
    const prUrl = readFlag(args, "--pr-url");
    if (!agentId || !summaryFile) {
      throw new Error("report-agent-done requires --agent-id <id> --summary-file <summary.md>.");
    }
    const summary = await fs.readFile(path.resolve(process.cwd(), summaryFile), "utf8");
    const event = {
      type: "orchestration.agent_done",
      agentId: Number(agentId),
      summary,
      prUrl: prUrl ?? null,
      createdAt: new Date().toISOString(),
    };
    await writeEvent(event);
    console.log(`reported agent ${agentId} done`);
    return;
  }

  usage();
  process.exitCode = 1;
}

function usage(): void {
  console.log(`Usage:
arcctl orchestrate status
arcctl orchestrate propose-plan --file <fleet-plan.json>
arcctl orchestrate spawn --file <fleet-plan.json>
arcctl orchestrate report-agent-done --agent-id <id> --summary-file <summary.md> --pr-url <url>`);
}

function readFlag(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] ?? null : null;
}

async function ensureBridge(): Promise<void> {
  await fs.mkdir(requestsDir, { recursive: true });
  await fs.mkdir(responsesDir, { recursive: true });
  await fs.appendFile(eventsFile, "");
}

async function writeRequest(type: string, payload: unknown): Promise<void> {
  const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${type}.json`;
  await fs.writeFile(path.join(requestsDir, name), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function writeEvent(payload: unknown): Promise<void> {
  await fs.appendFile(eventsFile, `${JSON.stringify(payload)}\n`, "utf8");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
