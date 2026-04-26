export type Block =
  | { type: "text"; content: string }
  | { type: "diff"; header: string; lines: DiffLine[] }
  | { type: "code"; lang: string; content: string }
  | { type: "cabinet"; fields: { label: string; value: string }[] }
  | { type: "structured"; label: string; value: string }
  | { type: "tokens"; value: string };

export type DiffLine = {
  kind: "add" | "remove" | "hunk" | "header" | "plain";
  text: string;
};

const DIFF_START = /^diff --git /;
const STRUCTURED_TAGS =
  "SUMMARY|CONTEXT|CONTEXT_UPDATE|ARTIFACT|DECISION|LEARNING|GOAL_UPDATE|MESSAGE_TO|SLACK|TASK_CREATE|TASK_COMPLETE";
const STRUCTURED_RE = new RegExp(
  `^(${STRUCTURED_TAGS})(?:\\s*\\[([^\\]]*)\\]|\\s+([^\\s:][^:]*?))?:\\s*(.*)$`
);
const STRUCTURED_LINE_RE = new RegExp(
  `^(${STRUCTURED_TAGS})(?:\\s*\\[([^\\]]*)\\]|\\s+([^\\s:][^:]*?))?:\\s+(.*)$`
);
const TOKENS_RE = /^[\d,]+$/;

function preprocess(text: string): string {
  return text
    .split("\n")
    .flatMap((line) => {
      if (DIFF_START.test(line)) return [line];
      const idx = line.indexOf("diff --git a/");
      if (idx > 0) {
        return [line.substring(0, idx), line.substring(idx)];
      }
      return [line];
    })
    .join("\n");
}

function isDiffStart(line: string): boolean {
  return DIFF_START.test(line);
}

function isDiffContentLine(line: string): boolean {
  if (line.startsWith("+") || line.startsWith("-")) return true;
  if (line.startsWith("@@")) return true;
  if (
    /^(index |new file|deleted file|old mode|new mode|similarity|rename|copy)/.test(line)
  ) {
    return true;
  }
  if (line.startsWith("+++") || line.startsWith("---")) return true;
  return false;
}

function parseDiffBlock(lines: string[], startIdx: number): {
  block: Block;
  endIdx: number;
} {
  const header = lines[startIdx];
  const diffLines: DiffLine[] = [];
  let i = startIdx + 1;

  while (i < lines.length) {
    const line = lines[i];
    if (isDiffStart(line)) break;

    if (line.startsWith("+++") || line.startsWith("---")) {
      diffLines.push({ kind: "header", text: line });
    } else if (line.startsWith("@@")) {
      diffLines.push({ kind: "hunk", text: line });
    } else if (line.startsWith("+")) {
      diffLines.push({ kind: "add", text: line });
    } else if (line.startsWith("-")) {
      diffLines.push({ kind: "remove", text: line });
    } else if (
      /^(index |new file|deleted file|old mode|new mode|similarity|rename|copy)/.test(line)
    ) {
      diffLines.push({ kind: "header", text: line });
    } else if (line.startsWith(" ") || line === "") {
      const hasHunks = diffLines.some((diffLine) => diffLine.kind === "hunk");
      if (hasHunks) {
        diffLines.push({ kind: "plain", text: line });
      } else {
        diffLines.push({ kind: "header", text: line });
      }
    } else {
      break;
    }
    i += 1;
  }

  return { block: { type: "diff", header, lines: diffLines }, endIdx: i };
}

function parseCodeBlock(
  lines: string[],
  startIdx: number
): { block: Block; endIdx: number } | null {
  const match = lines[startIdx].match(/^```(\w*)$/);
  if (!match) return null;

  const lang = match[1] || "text";
  const codeLines: string[] = [];
  let i = startIdx + 1;

  while (i < lines.length) {
    if (lines[i] === "```") {
      const nonEmpty = codeLines.filter((line) => line.trim());
      const allStructured =
        nonEmpty.length > 0 && nonEmpty.every((line) => STRUCTURED_RE.test(line));

      if (allStructured) {
        const fields = nonEmpty.map((line) => {
          const structuredMatch = line.match(STRUCTURED_RE)!;
          const recipient = structuredMatch[2] ?? structuredMatch[3];
          return {
            label: recipient
              ? `${structuredMatch[1]} [${recipient.trim()}]`
              : structuredMatch[1],
            value: structuredMatch[4],
          };
        });
        return { block: { type: "cabinet", fields }, endIdx: i + 1 };
      }

      return {
        block: { type: "code", lang, content: codeLines.join("\n") },
        endIdx: i + 1,
      };
    }
    codeLines.push(lines[i]);
    i += 1;
  }

  return null;
}

function parseStructuredLine(line: string): Block | null {
  const match = line.match(STRUCTURED_LINE_RE);
  if (!match) return null;
  const recipient = match[2] ?? match[3];
  const label = recipient ? `${match[1]} [${recipient.trim()}]` : match[1];
  return { type: "structured", label, value: match[4] };
}

export function parseTranscript(raw: string): Block[] {
  const text = preprocess(raw);
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let textBuf: string[] = [];

  function flushText() {
    if (textBuf.length === 0) return;

    const content = textBuf.join("\n").trim();
    if (!content) {
      textBuf = [];
      return;
    }

    const nonEmpty = textBuf.filter((line) => line.trim());
    const diffLikeCount = nonEmpty.filter((line) => isDiffContentLine(line)).length;
    if (nonEmpty.length > 0 && diffLikeCount / nonEmpty.length >= 0.5) {
      const diffLines: DiffLine[] = textBuf
        .filter((line) => line.trim())
        .map((line) => {
          if (line.startsWith("+")) return { kind: "add" as const, text: line };
          if (line.startsWith("-")) return { kind: "remove" as const, text: line };
          if (line.startsWith("@@")) return { kind: "hunk" as const, text: line };
          return { kind: "plain" as const, text: line };
        });
      blocks.push({ type: "diff", header: "", lines: diffLines });
    } else {
      blocks.push({ type: "text", content });
    }
    textBuf = [];
  }

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (isDiffStart(line)) {
      flushText();
      const result = parseDiffBlock(lines, i);
      blocks.push(result.block);
      i = result.endIdx;
      continue;
    }

    if (/^```/.test(line)) {
      const result = parseCodeBlock(lines, i);
      if (result) {
        flushText();
        blocks.push(result.block);
        i = result.endIdx;
        continue;
      }
    }

    const structured = parseStructuredLine(line);
    if (structured) {
      flushText();
      blocks.push(structured);
      i += 1;
      continue;
    }

    if (TOKENS_RE.test(line.trim()) && i >= lines.length - 3) {
      flushText();
      blocks.push({ type: "tokens", value: line.trim() });
      i += 1;
      continue;
    }

    textBuf.push(line);
    i += 1;
  }

  flushText();
  return blocks;
}
