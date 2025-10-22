import express, { Request, Response } from "express";
import cors from "cors";
import { z } from "zod";
import dotenv from 'dotenv';
import path from 'path';
import fs from "fs";
import { getToken, AuthConfig } from "./utils/auth";
import { fetchParams, SearchContextItem } from "./services/params";
import { AgentService, PlainMessage } from "./utils/agent";

type AgentType = "param" | "summary";

type AppCtx = {
  ready: boolean;
  token: string | null;
  tokenExpireAt: number;
  baseParams: SearchContextItem[];
  agentParams?: AgentService;
  agentSummary?: AgentService;
};

const app = express();
app.use(cors());
app.use(express.json());

const ctx: AppCtx = {
  ready: false,
  token: null,
  tokenExpireAt: 0,
  baseParams: [],
};

const envPath = path.resolve(process.cwd(), ".env");

function ensureReady(res: Response): boolean {
  if (!ctx.ready || !ctx.agentParams || !ctx.agentSummary) {
    res.status(503).json({ error: "Agent not ready" });
    return false;
  }
  return true;
}

function getSvc(agentType: AgentType): AgentService {
  if (agentType === "param") return ctx.agentParams!;
  return ctx.agentSummary!;
}

function pickCreatedMs(m: any): number {
  const CREATED_KEYS = ["created_at", "createdAt", "created", "createTime", "timestamp"];
  for (const k of CREATED_KEYS) {
    const v = m?.[k];
    if (v == null) continue;
    if (typeof v === "number") return v < 1e12 ? v * 1000 : v; // 秒或毫秒
    const t = new Date(v).getTime();
    if (Number.isFinite(t)) return t;
  }
  // 实在没有就兜底到当前时间，避免排序报错（不改造对象）
  return Date.now();
}

function byCreatedAsc(a: any, b: any): number {
  const ta = pickCreatedMs(a);
  const tb = pickCreatedMs(b);
  if (ta !== tb) return ta - tb;
  // 二级排序尽量稳定（不生成新对象）
  const ida = (a?.id ?? a?._id ?? "");
  const idb = (b?.id ?? b?._id ?? "");
  return String(ida).localeCompare(String(idb));
}

if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
  console.log(`[env] Loaded from ${envPath}`);
} else {
  console.warn(`[env] No .env file found at ${envPath}, skipping`);
}

// —— 路由（先定义，启动时再 listen） —— //
app.get("/ping", (_req: Request, res: Response) =>
  res.json({ message: "AQP MCP Server (Express, TS, Node16) OK", ts: new Date().toISOString() })
);

app.get("/readyz", (_req: Request, res: Response) =>
  res.status(ctx.ready ? 200 : 503).json({ ready: ctx.ready })
);

const MessageSchema = z.object({
  threadId: z.string().min(1).optional(),
  message: z.string().optional(),
});

// 单一发送接口：/node/agent/send
// body: { agentType: "param" | "summary", threadId?: string, message: string }
app.post("/node/agent/send", async (req: Request, res: Response) => {
  if (!ensureReady(res)) return;

  const agentType = String(req.body?.agentType ?? "").trim() as AgentType;
  if (agentType !== "param" && agentType !== "summary") {
    return res.status(400).json({ error: "agentType must be 'param' or 'summary'" });
  }

  const message = String(req.body?.message ?? "").trim();
  if (!message) {
    return res.status(400).json({ error: "Message required" });
  }

  let threadId: string | undefined = req.body?.threadId;

  try {
    const svc = getSvc(agentType);

    if (!threadId) {
      const t = await svc.createThread();
      threadId = t.id;
      console.log(`[send/${agentType}] Created thread: ${threadId}`);
    } else {
      console.log(`[send/${agentType}] Continue thread: ${threadId}`);
    }

    await svc.appendAndRun(threadId, message);
    res.json({ agent: agentType, threadId });
  } catch (e: any) {
    console.error("POST /node/agent/send error:", e);
    res.status(500).json({ error: e?.message ?? "Internal Server Error" });
  }
});


// 合并两条 thread 消息并按创建时间排序
// body: { paramThreadId?: string, summaryThreadId?: string, limit?: number }
app.post("/node/agent/messages", async (req: Request, res: Response) => {
  if (!ensureReady(res)) return;

  const { paramThreadId, summaryThreadId, limit } = req.body ?? {};
  if (!paramThreadId && !summaryThreadId) {
    return res.status(400).json({ error: "paramThreadId or summaryThreadId required" });
  }

  try {
    const [rawParam, rawSummary] = await Promise.all([
      paramThreadId ? ctx.agentParams!.listMessages(paramThreadId) : Promise.resolve([]),
      summaryThreadId ? ctx.agentSummary!.listMessages(summaryThreadId) : Promise.resolve([]),
    ]);

    // 不改结构，直接合并原始对象
    const merged: any[] = [...(rawParam || []), ...(rawSummary || [])].sort(byCreatedAsc);

    const limited =
      typeof limit === "number" && limit > 0 ? merged.slice(-limit) : merged;

    res.json({
      paramThreadId: paramThreadId ?? null,
      summaryThreadId: summaryThreadId ?? null,
      mergedCount: limited.length,
      messages: limited, // 原样对象，已按创建时间升序
    });
  } catch (e: any) {
    console.error("POST /node/agent/messages error:", e);
    res.status(500).json({ error: e?.message ?? "Internal Server Error" });
  }
});

async function bootstrap() {
  const projectUrl = process.env.AZURE_AI_PROJECT_URL || "";
  const paramAgentId = process.env.AZURE_Params_AGENT_ID || "";
  const summaryAgentId = process.env.AZURE_Summary_AGENT_ID || "";

  if (!projectUrl || !paramAgentId || !summaryAgentId) {
    throw new Error("Missing env: AZURE_AI_PROJECT_URL or agent IDs");
  }

  // 初始化两个 agent 实例
  const paramAgent = new AgentService({ projectUrl, agentId: paramAgentId });
  const summaryAgent = new AgentService({ projectUrl, agentId: summaryAgentId });

  // 并行等待两个 agent 都 ready（性能更好）
  const [paramInfo, summaryInfo] = await Promise.all([
    paramAgent.ensureAgentReady(),
    summaryAgent.ensureAgentReady(),
  ]);

  console.log(`[bootstrap] ParamAgent ready: ${paramInfo.name} (${paramInfo.id})`);
  console.log(`[bootstrap] SummaryAgent ready: ${summaryInfo.name} (${summaryInfo.id})`);

  // 绑定到全局上下文 ctx（或导出对象）
  ctx.agentParams = paramAgent;
  ctx.agentSummary = summaryAgent;

  ctx.ready = true;
  console.log("[bootstrap] done");
}

// —— 优雅退出 —— //
function shutdown(signal: string) {
  console.log(`[shutdown] ${signal}`);
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// —— 先初始化，再启动 —— //
(async () => {
  try {
    await bootstrap();
    const PORT = Number(process.env.PORT || 8080);
    app.listen(PORT, () => console.log(`✅ Server running at http://localhost:${PORT}`));
  } catch (e) {
    console.error("[start] bootstrap failed:", e);
    process.exit(1);
  }
})();
