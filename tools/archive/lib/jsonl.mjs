import { readFile, writeFile } from "node:fs/promises";

const JSONL_ERROR_CODE = "JSONL_FORMAT_ERROR";
const JSONL_MISSING_EOF = "JSONL_MISSING_EOF_NEWLINE";

function jsonlError(code, message, path) {
  const error = new TypeError(message);
  error.code = code;
  if (path) error.path = path;
  return error;
}

export async function readJsonl(path) {
  const contents = await readFile(path, "utf8");
  if (contents.length === 0) return [];

  if (!contents.endsWith("\n")) {
    throw jsonlError(JSONL_MISSING_EOF, "jsonl file must end with a newline");
  }

  const lines = contents.split("\n");
  if (lines.at(-1) !== "") {
    throw jsonlError(JSONL_MISSING_EOF, "jsonl file must end with a newline");
  }
  lines.pop();

  if (lines.some((line) => line.length === 0)) {
    throw jsonlError(JSONL_ERROR_CODE, "jsonl must not contain empty lines");
  }

  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (cause) {
      throw jsonlError(JSONL_ERROR_CODE, `invalid json on line ${index + 1}`, path);
    }
  });
}

export function writeJsonlBytes(records) {
  if (!Array.isArray(records)) {
    throw jsonlError(JSONL_ERROR_CODE, "writeJsonlBytes records must be an array");
  }
  const safeRecords = records.map((record, index) => {
    try {
      return JSON.stringify(record);
    } catch (cause) {
      throw jsonlError(JSONL_ERROR_CODE, `record ${index} is not serializable`);
    }
  });
  const payload = `${safeRecords.join("\n")}\n`;
  return Buffer.from(payload, "utf8");
}

export async function writeJsonl(path, records) {
  const bytes = writeJsonlBytes(records);
  await writeFile(path, bytes);
}
