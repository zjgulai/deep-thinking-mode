#!/usr/bin/env node
import { fileURLToPath } from "node:url";

import { loadV3AgentData, V3_AGENT_DATA_ERROR } from "./lib/v3-agent-data.mjs";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const FROZEN_COUNTS = Object.freeze({
  modelCount: 2789,
  uniqueIdCount: 2789,
  problemTypeCount: 8,
  agentStageCount: 8,
  routeCount: 23,
  chainCount: 5,
  chainReferenceCount: 13,
  curatedModelReferenceCount: 48
});

export function assertFrozenCounts(stats) {
  for (const [field, expected] of Object.entries(FROZEN_COUNTS)) {
    if (stats[field] !== expected) {
      const error = new RangeError(`expected frozen ${field} ${expected}, received ${stats[field]}`);
      error.code = V3_AGENT_DATA_ERROR;
      error.path = `stats.${field}`;
      throw error;
    }
  }
}

export async function main() {
  try {
    const result = await loadV3AgentData(rootDir);
    assertFrozenCounts(result.stats);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      schema_version: "3.0.0",
      ...result.stats,
      safetySignalCount: result.safetySignals.length,
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
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
