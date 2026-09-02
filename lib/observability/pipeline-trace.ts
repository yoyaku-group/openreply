import { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";

type PipelineTraceInput = {
  source?: "SYSTEM" | "WORKER";
  level?: "INFO" | "WARNING" | "ERROR";
  message: string;
  payload?: Record<string, unknown>;
  workspaceId?: string | null;
};

/**
 * Step-level tracing for the comment→DM pipeline so a live Meta test can be
 * followed end to end from the diagnostics page or SQL. On by default; set
 * DM_PIPELINE_TRACE=0 to silence. Failure paths keep their dedicated
 * ERROR/WARNING events and stay ungated. A tracing failure must never break
 * the pipeline it observes.
 */
export function pipelineTraceEnabled(): boolean {
  const raw = process.env.DM_PIPELINE_TRACE;
  return raw !== "0" && raw?.toLowerCase() !== "false";
}

export async function tracePipeline(input: PipelineTraceInput): Promise<void> {
  if (!pipelineTraceEnabled()) return;
  try {
    await prisma.operationalEvent.create({
      data: {
        workspaceId: input.workspaceId ?? null,
        source: input.source ?? "SYSTEM",
        level: input.level ?? "INFO",
        message: input.message,
        ...(input.payload
          ? { payload: input.payload as Prisma.InputJsonValue }
          : {}),
      },
    });
  } catch (error) {
    console.warn("[Pipeline Trace] failed to record event:", error);
  }
}
