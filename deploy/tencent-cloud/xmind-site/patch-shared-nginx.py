#!/usr/bin/env python3
"""Insert the xmind server blocks into exactly one top-level Nginx http block."""

from __future__ import annotations

import argparse
import re
from pathlib import Path


BEGIN_MARKER = "# BEGIN xmind.lute-tlz-dddd.top"
END_MARKER = "# END xmind.lute-tlz-dddd.top"
DOMAIN = "xmind.lute-tlz-dddd.top"


def mask_comments_and_strings(source: str) -> str:
    masked = list(source)
    quote: str | None = None
    escaped = False
    comment = False

    for index, char in enumerate(source):
        if comment:
            if char == "\n":
                comment = False
            else:
                masked[index] = " "
            continue

        if quote:
            if escaped:
                escaped = False
                masked[index] = " "
            elif char == "\\":
                escaped = True
                masked[index] = " "
            elif char == quote:
                quote = None
                masked[index] = " "
            else:
                masked[index] = " "
            continue

        if char == "#":
            comment = True
            masked[index] = " "
        elif char in {'"', "'"}:
            quote = char
            masked[index] = " "

    if quote:
        raise ValueError("unterminated quoted string in Nginx configuration")
    return "".join(masked)


def find_http_closing_brace(source: str) -> int:
    masked = mask_comments_and_strings(source)
    matches = list(re.finditer(r"(?m)^\s*http\s*\{", masked))
    if len(matches) != 1:
        raise ValueError(f"expected exactly one top-level http block, found {len(matches)}")

    opening = masked.find("{", matches[0].start(), matches[0].end())
    depth = 0
    for index in range(opening, len(masked)):
        if masked[index] == "{":
            depth += 1
        elif masked[index] == "}":
            depth -= 1
            if depth == 0:
                return index
            if depth < 0:
                break
    raise ValueError("unbalanced braces in Nginx http block")


def build_candidate(base: str, snippet: str) -> str:
    if BEGIN_MARKER in base or END_MARKER in base or DOMAIN in base:
        raise ValueError("xmind domain or deployment marker already exists in base config")
    if DOMAIN not in snippet:
        raise ValueError("snippet does not contain the expected xmind domain")
    if BEGIN_MARKER in snippet or END_MARKER in snippet:
        raise ValueError("snippet must not contain deployment markers")

    closing = find_http_closing_brace(base)
    indented = "\n".join(f"    {line}" if line else "" for line in snippet.strip().splitlines())
    insertion = f"\n\n    {BEGIN_MARKER}\n{indented}\n    {END_MARKER}\n"
    return f"{base[:closing].rstrip()}{insertion}{base[closing:]}"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", type=Path, required=True)
    parser.add_argument("--snippet", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.output.exists() or args.output.is_symlink():
        raise SystemExit(f"refusing to overwrite output: {args.output}")

    base = args.base.read_text(encoding="utf-8")
    snippet = args.snippet.read_text(encoding="utf-8")
    candidate = build_candidate(base, snippet)
    args.output.write_text(candidate, encoding="utf-8", newline="")
    print(f"wrote {args.output} with one marked xmind server-block insertion")


if __name__ == "__main__":
    main()
