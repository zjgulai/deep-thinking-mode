import { verifySecurityHeadersAtUrl } from "./lib/site-security.mjs";

function readUrl(argv) {
  const index = argv.indexOf("--url");
  if (index === -1) return "https://xmind.lute-tlz-dddd.top/";
  if (!argv[index + 1]) throw new Error("--url requires a value");
  return argv[index + 1];
}

try {
  const result = await verifySecurityHeadersAtUrl(readUrl(process.argv.slice(2)));
  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(error);
    process.exitCode = 1;
  } else {
    console.log(`Security headers verified: ${result.url}`);
  }
} catch (error) {
  console.error(`SECURITY_HEADER_CHECK_FAILED: ${error.message}`);
  process.exitCode = 1;
}
