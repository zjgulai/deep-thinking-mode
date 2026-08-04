#!/usr/bin/env node
import { runCorpusCli } from "./lib/cli.mjs";

const result = await runCorpusCli(process.argv.slice(2));
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = result.exitCode;
