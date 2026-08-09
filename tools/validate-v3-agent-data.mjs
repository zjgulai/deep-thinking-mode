#!/usr/bin/env node
import { fileURLToPath } from "node:url";

import { loadV3AgentData } from "./lib/v3-agent-data.mjs";

const rootDir = fileURLToPath(new URL("..", import.meta.url));

try {
  const result = await loadV3AgentData(rootDir);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    schema_version: "3.0.0",
    ...result.stats,
    agentRoles: result.agentRoles,
    roleCounts: result.roleCounts
  }, null, 2)}\n`);
} catch (cause) {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    code: cause.code ?? "V3_AGENT_DATA_INVALID",
    path: cause.path ?? null,
    message: cause.message
  }, null, 2)}\n`);
  process.exitCode = 1;
}
