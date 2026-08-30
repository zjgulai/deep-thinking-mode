#!/usr/bin/env node

import process from "node:process";

import { auditProductionPages } from "./lib/production-page-audit.mjs";

function parseArgs(argv) {
  const options = {
    siteDir: "site",
    targetUrl: process.env.PRODUCTION_URL || "https://xmind.lute-tlz-dddd.top/",
  };
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      json = true;
    } else if (["--url", "--site-dir", "--concurrency"].includes(argument)) {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} requires a value`);
      if (argument === "--url") options.targetUrl = value;
      if (argument === "--site-dir") options.siteDir = value;
      if (argument === "--concurrency") options.concurrency = Number(value);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return { json, options };
}

async function main() {
  const { json, options } = parseArgs(process.argv.slice(2));
  if (!json) console.log(`Auditing every production page: ${options.targetUrl}`);
  const result = await auditProductionPages(options);
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Files: ${result.checkedFiles}; HTML pages: ${result.checkedPages}`);
    for (const [type, count] of Object.entries(result.pageTypes)) {
      console.log(`  ${type}: ${count}`);
    }
    if (result.errors.length === 0) {
      console.log("✓ Production page audit passed with no findings.");
    } else {
      console.error(`✗ Production page audit failed (${result.errors.length} findings):`);
      for (const error of result.errors) console.error(`  ${error}`);
    }
  }
  if (result.errors.length > 0) process.exitCode = 1;
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
