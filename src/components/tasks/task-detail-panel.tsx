"use client";

import { useState } from "react";
import { BrainCircuit, X } from "lucide-react";
import { useAppStore } from "@/stores/app-store";
import { ConversationSessionView } from "@/components/agents/conversation-session-view";
import { Button } from "@/components/ui/button";
import { formatEffortName } from "@/lib/agents/runtime-options";
import type {
  ConversationDetail,
  ConversationMeta,
  ConversationStatus,
} from "@/types/conversations";
import { openArtifactPath } from "@/lib/navigation/open-artifact-path";

function StatusDot({ status }: { status: ConversationStatus }) {
  if (status === "running") {
    return <span className="relative flex h-2 w-2 shrink-0"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" /><span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" /></span>;
  }
  if (status === "completed") {
    return <span className="inline-flex h-2 w-2 shrink-0 rounded-full bg-emerald-500" />;
  }
  if (status === "failed") {
    return <span className="inline-flex h-2 w-2 shrink-0 rounded-full bg-destructive" />;
  }
  return <span className="inline-flex h-2 w-2 shrink-0 rounded-full bg-muted-foreground/40" />;
}

function formatRelative(iso?: string): string {
  if (!iso) return "just now";
  const delta = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(delta / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function startCase(value: string | undefined, fallback = "General"): string {
  if (!value) return fallback;
  const words = value.trim().split(/[\s_-]+/).filter(Boolean);
  if (words.length === 0) return fallback;
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

function readConversationModel(meta: Pick<ConversationMeta, "adapterConfig">): string | null {
  const config = meta.adapterConfig;
  if (!config || typeof config !== "object") return null;
  const model = config.model;
  return typeof model === "string" && model.trim() ? model.trim() : null;
}

function readConversationEffort(meta: Pick<ConversationMeta, "adapterConfig">): string | null {
  const config = meta.adapterConfig;
  if (!config || typeof config !== "object") return null;
  const effort =
    typeof config.effort === "string" && config.effort.trim()
      ? config.effort
      : typeof config.reasoningEffort === "string" && config.reasoningEffort.trim()
        ? config.reasoningEffort
        : null;

  return effort ? formatEffortName(effort) : null;
}

function formatProviderLabel(providerId?: string): string | null {
  if (!providerId) return null;

  return providerId
    .split(/[-_]+/)
    .filter(Boolean)
    .map((segment) => {
      const upper = segment.toUpperCase();
      if (upper === "API" || upper === "CLI") return upper;
      return segment.charAt(0).toUpperCase() + segment.slice(1);
    })
    .join(" ");
}

function formatRuntimeName(runtime?: ConversationMeta["runtime"]): string | null {
  if (!runtime) return null;
  if (runtime === "pty") return "PTY";
  if (runtime === "headless") return "Headless";
  if (runtime === "structured") return "Structured";
  return null;
}

function buildRuntimeLabel(
  meta: Pick<ConversationMeta, "adapterConfig" | "providerId" | "runtime">
): string | null {
  const model = readConversationModel(meta);
  const effort = readConversationEffort(meta);
  const provider = formatProviderLabel(meta.providerId);
  const runtime = formatRuntimeName(meta.runtime);

  const baseSegments = [model, provider, effort].filter(Boolean) as string[];
  let base: string | null = baseSegments.length > 0 ? baseSegments.join(" · ") : null;
  if (!base && provider) base = `${provider} · default model`;

  if (base && runtime) return `${base} · ${runtime}`;
  if (base) return base;
  if (runtime) return runtime;
  return null;
}

function formatDurationMs(ms?: number): string | null {
  if (typeof ms !== "number" || ms <= 0) return null;
  const totalSec = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function buildDiagnosticsLine(meta: ConversationMeta): string | null {
  const parts: string[] = [];
  const duration = formatDurationMs(meta.durationMs);
  if (duration) parts.push(duration);
  if (meta.timedOut) parts.push("timed out");
  if (typeof meta.signal === "number" && meta.signal > 0) {
    parts.push(`signal ${meta.signal}`);
  } else if (typeof meta.exitCode === "number" && meta.exitCode !== 0) {
    parts.push(`exit ${meta.exitCode}`);
  }
  if (meta.killReason && meta.killReason !== "exit") {
    parts.push(meta.killReason);
  }
  if (meta.resolvedStatusSource) {
    parts.push(meta.resolvedStatusSource);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function TaskDetailPanel() {
  const conversation = useAppStore((s) => s.taskPanelConversation);
  const setTaskPanelConversation = useAppStore((s) => s.setTaskPanelConversation);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);

  if (!conversation) return null;
  const activeConversation = detail?.meta.id === conversation.id ? detail.meta : conversation;
  const runtimeLabel = buildRuntimeLabel(activeConversation);

  return (
    <div className="flex h-full w-[420px] shrink-0 flex-col border-l border-border/70 bg-background">
      <div className="flex items-center gap-2 border-b border-border/70 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <StatusDot status={activeConversation.status} />
            <p className="truncate text-[13px] font-medium text-foreground">
              {activeConversation.title}
            </p>
          </div>
          <p className="mt-0.5 truncate pl-4 text-[11px] text-muted-foreground">
            {startCase(activeConversation.agentSlug)}
            {" · "}
            {formatRelative(activeConversation.startedAt)}
          </p>
          {runtimeLabel ? (
            <div className="mt-1 flex items-center gap-1.5 pl-4 text-[11px] text-muted-foreground">
              <BrainCircuit className="size-3.5 shrink-0" />
              <p className="truncate">{runtimeLabel}</p>
            </div>
          ) : null}
          {(() => {
            const diagnostics = buildDiagnosticsLine(activeConversation);
            return diagnostics ? (
              <p className="mt-0.5 truncate pl-4 text-[11px] text-muted-foreground/80">
                {diagnostics}
              </p>
            ) : null;
          })()}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 shrink-0 p-0"
          onClick={() => setTaskPanelConversation(null)}
        >
          <X className="size-4" />
        </Button>
      </div>

      <div className="flex-1 overflow-hidden">
        <ConversationSessionView
          conversation={conversation}
          onDetailChange={setDetail}
          onOpenArtifact={(artifactPath) => {
            void openArtifactPath(artifactPath, { type: "page" });
          }}
        />
      </div>
    </div>
  );
}
