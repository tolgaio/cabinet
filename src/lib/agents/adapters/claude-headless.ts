import { spawn } from "child_process";
import readline from "readline";

import type {
  AdapterBillingType,
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterUsageSummary,
  AgentExecutionAdapter,
} from "./types";
import { providerStatusToEnvironmentTest } from "./environment";
import { resolveCliCommand } from "../provider-cli";
import { claudeCodeProvider } from "../providers/claude-code";
import { ADAPTER_RUNTIME_PATH } from "./utils";
import {
  appendConversationEvent,
  readConversationMeta,
  type ConversationEvent,
} from "../conversation-store";

const HEARTBEAT_LEAK_KEYS = ["CLAUDECODE", "CLAUDE_CODE_"];

function readStringConfig(
  config: Record<string, unknown>,
  key: string
): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumberConfig(
  config: Record<string, unknown>,
  key: string
): number | undefined {
  const value = config[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function buildHeadlessArgs(config: Record<string, unknown>): string[] {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--verbose",
    "--strict-mcp-config",
    "--permission-mode",
    "bypassPermissions",
  ];

  const model = readStringConfig(config, "model");
  if (model) {
    args.push("--model", model);
  }

  const maxTurns = readNumberConfig(config, "maxTurns");
  if (maxTurns) {
    args.push("--max-turns", String(Math.floor(maxTurns)));
  }

  const appendSystemPrompt =
    readStringConfig(config, "appendSystemPrompt") ||
    readStringConfig(config, "systemPrompt");
  if (appendSystemPrompt) {
    args.push("--append-system-prompt", appendSystemPrompt);
  }

  const resumeSessionId = readStringConfig(config, "resumeSessionId");
  if (resumeSessionId) {
    args.push("--resume", resumeSessionId);
  }

  return args;
}

function buildHeadlessEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== "string") continue;
    if (HEARTBEAT_LEAK_KEYS.some((prefix) => key.startsWith(prefix))) continue;
    out[key] = value;
  }
  out.PATH = ADAPTER_RUNTIME_PATH;
  return out;
}

interface UsagePayload {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
}

interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
}

interface ClaudeMessageBody {
  role?: string;
  model?: string;
  content?: ContentBlock[];
  usage?: UsagePayload;
}

interface ClaudeStreamMessage {
  type?: string;
  subtype?: string;
  session_id?: string;
  apiKeySource?: string;
  message?: ClaudeMessageBody;
  result?: string;
  is_error?: boolean;
  usage?: UsagePayload;
  request_id?: string;
  request?: {
    subtype?: string;
    tool_use?: {
      id?: string;
      name?: string;
      input?: unknown;
    };
  };
  log?: {
    level?: string;
    message?: string;
  };
}

function parseUsage(payload?: UsagePayload): AdapterUsageSummary | undefined {
  if (!payload) return undefined;
  const inputTokens = payload.input_tokens;
  const outputTokens = payload.output_tokens;
  if (typeof inputTokens !== "number" || typeof outputTokens !== "number") {
    return undefined;
  }
  return {
    inputTokens,
    outputTokens,
    ...(typeof payload.cache_read_input_tokens === "number"
      ? { cachedInputTokens: payload.cache_read_input_tokens }
      : {}),
  };
}

function stringifyUnknown(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

interface AccumulatorState {
  sessionId: string | null;
  model: string | null;
  billingType: AdapterBillingType | null;
  usage: AdapterUsageSummary | undefined;
  finalText: string | null;
  isError: boolean;
  errorMessage: string | null;
}

function createAccumulator(): AccumulatorState {
  return {
    sessionId: null,
    model: null,
    billingType: null,
    usage: undefined,
    finalText: null,
    isError: false,
    errorMessage: null,
  };
}

interface NormalizationResult {
  events: ConversationEvent[];
  display: string;
  controlResponse?: string;
}

function normalizeMessage(
  raw: ClaudeStreamMessage,
  acc: AccumulatorState
): NormalizationResult {
  const events: ConversationEvent[] = [];
  let display = "";
  let controlResponse: string | undefined;
  const at = new Date().toISOString();

  if (typeof raw.session_id === "string" && raw.session_id) {
    acc.sessionId = raw.session_id;
  }
  if (typeof raw.apiKeySource === "string" && !acc.billingType) {
    acc.billingType = raw.apiKeySource === "none" ? "subscription" : "api";
  }
  const usage = parseUsage(raw.usage) || parseUsage(raw.message?.usage);
  if (usage) acc.usage = usage;
  if (raw.message?.model) acc.model = raw.message.model;

  switch (raw.type) {
    case "system": {
      events.push({
        at,
        type: "system",
        subtype: raw.subtype,
        sessionId: acc.sessionId,
      });
      break;
    }
    case "assistant": {
      const blocks = raw.message?.content || [];
      for (const block of blocks) {
        if (block.type === "text" && typeof block.text === "string") {
          events.push({
            at,
            type: "text",
            text: block.text,
            sessionId: acc.sessionId,
          });
          display += block.text;
        } else if (
          block.type === "thinking" &&
          typeof block.thinking === "string"
        ) {
          events.push({
            at,
            type: "thinking",
            text: block.thinking,
            sessionId: acc.sessionId,
          });
        } else if (block.type === "tool_use") {
          events.push({
            at,
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: block.input,
            sessionId: acc.sessionId,
          });
          display += `\n[tool_use ${block.name || "?"}]\n`;
        }
      }
      break;
    }
    case "user": {
      const blocks = raw.message?.content || [];
      for (const block of blocks) {
        if (block.type === "tool_result") {
          const text = stringifyUnknown(block.content);
          events.push({
            at,
            type: "tool_result",
            toolUseId: block.tool_use_id,
            text,
            sessionId: acc.sessionId,
          });
          if (text) display += `${text}\n`;
        }
      }
      break;
    }
    case "result": {
      const text = typeof raw.result === "string" ? raw.result : "";
      if (text) acc.finalText = text;
      if (raw.is_error) {
        acc.isError = true;
        acc.errorMessage = text || "Claude reported an error result.";
      }
      events.push({
        at,
        type: "result",
        text,
        isError: Boolean(raw.is_error),
        sessionId: acc.sessionId,
      });
      break;
    }
    case "log": {
      events.push({
        at,
        type: "log",
        level: raw.log?.level,
        message: raw.log?.message,
      });
      break;
    }
    case "control_request": {
      const requestId = raw.request_id || "";
      const subtype = raw.request?.subtype || "";
      const allowedToolUse = subtype === "can_use_tool" && raw.request?.tool_use;
      const responsePayload = allowedToolUse
        ? {
            type: "control_response",
            response: {
              subtype: "success",
              request_id: requestId,
              response: {
                behavior: "allow",
                updatedInput: raw.request?.tool_use?.input ?? {},
              },
            },
          }
        : {
            type: "control_response",
            response: {
              subtype: "success",
              request_id: requestId,
              response: { behavior: "allow" },
            },
          };
      controlResponse = `${JSON.stringify(responsePayload)}\n`;
      events.push({
        at,
        type: "control_request_auto_allowed",
        requestId,
        subtype,
        sessionId: acc.sessionId,
      });
      break;
    }
    default: {
      events.push({
        at,
        type: "unknown",
        rawType: raw.type,
        sessionId: acc.sessionId,
      });
      break;
    }
  }

  return { events, display, controlResponse };
}

function buildInitialPromptEnvelope(prompt: string): string {
  return `${JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text: prompt }],
    },
  })}\n`;
}

function firstNonEmptyLine(text: string): string | null {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) || null
  );
}

async function runHeadless(
  ctx: AdapterExecutionContext,
  command: string
): Promise<AdapterExecutionResult> {
  const args = buildHeadlessArgs(ctx.config);
  const env = buildHeadlessEnv();
  const startedAt = new Date().toISOString();
  const meta = await readConversationMeta(ctx.runId).catch(() => null);
  const cabinetPath = meta?.cabinetPath;
  const recordEvent = (event: ConversationEvent) => {
    void appendConversationEvent(ctx.runId, event, cabinetPath).catch(() => {});
  };

  await ctx.onMeta?.({
    adapterType: ctx.adapterType,
    command,
    commandArgs: args,
    cwd: ctx.cwd,
    env: { PATH: env.PATH },
  });

  const child = spawn(command, args, {
    cwd: ctx.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (typeof child.pid === "number" && child.pid > 0) {
    await ctx.onSpawn?.({
      pid: child.pid,
      processGroupId:
        process.platform === "win32" ? null : child.pid,
      startedAt,
    });
  }

  const acc = createAccumulator();
  let stderrBuffer = "";
  let timedOut = false;
  let killTimer: NodeJS.Timeout | null = null;

  const writeToStdin = (payload: string) => {
    if (!child.stdin.writable) return;
    try {
      child.stdin.write(payload);
    } catch {
      // EPIPE during shutdown — safe to ignore.
    }
  };

  child.stdin.on("error", () => {
    // Ignore stdin errors; child may close before we finish writing.
  });

  child.stderr.on("data", (buffer: Buffer) => {
    const chunk = buffer.toString();
    stderrBuffer += chunk;
    void ctx.onLog("stderr", chunk);
  });

  const stdoutLines = readline.createInterface({
    input: child.stdout,
    crlfDelay: Infinity,
  });

  stdoutLines.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: ClaudeStreamMessage | null = null;
    try {
      parsed = JSON.parse(trimmed) as ClaudeStreamMessage;
    } catch {
      recordEvent({
        at: new Date().toISOString(),
        type: "parse_error",
        raw: trimmed.slice(0, 4000),
      });
      return;
    }

    const result = normalizeMessage(parsed, acc);
    for (const event of result.events) {
      recordEvent(event);
    }
    if (result.display) {
      void ctx.onLog("stdout", result.display);
    }
    if (result.controlResponse) {
      writeToStdin(result.controlResponse);
    }
  });

  if (ctx.timeoutMs && ctx.timeoutMs > 0) {
    setTimeout(() => {
      if (child.exitCode !== null || child.signalCode) return;
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {}
      killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
      }, 5000);
    }, ctx.timeoutMs).unref();
  }

  writeToStdin(buildInitialPromptEnvelope(ctx.prompt));
  // Single-shot: signal end-of-input so Claude exits after the result event
  // instead of parking in epoll_wait expecting more stream-json turns.
  // Multi-turn happens via fresh `--resume <session_id>` invocations, not by
  // keeping this stdin open. `bypassPermissions` means no control_request
  // round-trip is needed.
  try {
    child.stdin.end();
  } catch {
    // Already closed or errored — covered by the stdin error handler above.
  }

  const exitInfo = await new Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", (error) => {
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      if (killTimer) clearTimeout(killTimer);
      resolve({ exitCode, signal: signal as NodeJS.Signals | null });
    });
  });

  // The child has fully closed by the time we get here, so its stdout has
  // already ended and readline has flushed all "line" events. Closing the
  // interface defensively in case it isn't already, but we don't await its
  // "close" — by the time we attach the listener, the event has typically
  // already fired and the await would hang.
  if (!stdoutLines.closed) {
    stdoutLines.close();
  }

  const output = acc.finalText || null;
  const summaryLine = output ? firstNonEmptyLine(output)?.slice(0, 300) || null : null;
  const failed =
    acc.isError ||
    (typeof exitInfo.exitCode === "number" && exitInfo.exitCode !== 0) ||
    timedOut;

  // The daemon decides "completed" vs "failed" from exitCode === 0 && !timedOut.
  // If Claude reported is_error in its result event but exited with code 0, we
  // force the exit code to 1 so the surrounding pipeline records the failure.
  const reportedExitCode =
    failed && exitInfo.exitCode === 0 ? 1 : exitInfo.exitCode;

  return {
    exitCode: reportedExitCode,
    signal: exitInfo.signal,
    timedOut,
    errorMessage: failed
      ? acc.errorMessage ||
        stderrBuffer.trim() ||
        (timedOut
          ? `Claude headless timed out after ${ctx.timeoutMs}ms`
          : "Claude headless execution failed.")
      : null,
    usage: acc.usage,
    sessionId: acc.sessionId,
    provider: claudeCodeProvider.id,
    model: acc.model,
    billingType: acc.billingType || "subscription",
    summary: summaryLine,
    output,
  };
}

export const claudeHeadlessAdapter: AgentExecutionAdapter = {
  type: "claude_headless",
  name: "Claude Headless",
  description:
    "Runs Claude Code in headless mode (`claude -p --output-format stream-json --input-format stream-json --permission-mode bypassPermissions`) and streams structured events. Inspired by the multica daemon. No PTY.",
  providerId: claudeCodeProvider.id,
  executionEngine: "structured_cli",
  experimental: true,
  supportsDetachedRuns: true,
  // Resume requires plumbing the prior session_id through to a follow-up run;
  // the adapter accepts `resumeSessionId` in its config but the surrounding
  // conversation flow does not yet capture and forward the captured id.
  supportsSessionResume: false,
  models: claudeCodeProvider.models,
  effortLevels: claudeCodeProvider.effortLevels,
  async testEnvironment() {
    return providerStatusToEnvironmentTest(
      "claude_headless",
      await claudeCodeProvider.healthCheck(),
      claudeCodeProvider.installMessage
    );
  },
  async execute(ctx) {
    const command =
      readStringConfig(ctx.config, "command") || resolveCliCommand(claudeCodeProvider);
    return runHeadless(ctx, command);
  },
};
