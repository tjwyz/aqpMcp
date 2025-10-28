import express, { Request, Response } from "express";
import cors from "cors";
import dotenv from 'dotenv';
import path from 'path';
import fs from "fs";
import { AgentService } from "./utils/agent";

type AgentType = "params" | "summary" | "route";

type AppCtx = {
  ready: boolean;
  agentParams?: AgentService;
  agentSummary?: AgentService;
  agentRouting?: AgentService;
};

const app = express();
app.use(cors());
app.use(express.json());

const ctx: AppCtx = {
  ready: false,
};

const envPath = path.resolve(process.cwd(), ".env");

function ensureReady(res: Response): boolean {
  if (!ctx.ready || !ctx.agentParams || !ctx.agentSummary || !ctx.agentRouting) {
    res.status(503).json({ error: "Agent not ready" });
    return false;
  }
  return true;
}

function getSvc(agentType: AgentType): AgentService {
  if (agentType === "params") return ctx.agentParams!;
  if (agentType === "summary") return ctx.agentSummary!;
  return ctx.agentRouting!; // "route"
}

function getLastAssistantMessage(messages: any[]): any | null {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const role = m?.role ?? m?.author ?? m?.from ?? "";
    if (String(role).toLowerCase() === "assistant") {
      return m;
    }
  }
  return messages[messages.length - 1] ?? null; // fallback
}

if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
  console.log(`[env] Loaded from ${envPath}`);
} else {
  console.warn(`[env] No .env file found at ${envPath}, skipping`);
}

app.get("/ping", (_req: Request, res: Response) =>
  res.json({ message: "AQP MCP Server (Express, TS, Node16) OK", ts: new Date().toISOString() })
);

app.get("/readyz", (_req: Request, res: Response) =>
  res.status(ctx.ready ? 200 : 503).json({ ready: ctx.ready })
);

// body: { agentType: "params" | "route", threadId?: string, message: string }
app.post("/node/agent/send", async (req: Request, res: Response) => {
  if (!ensureReady(res)) return;

  const agentType = String(req.body?.agentType ?? "").trim() as AgentType;
  if (agentType !== "params" && agentType !== "summary" && agentType !== "route") {
    return res.status(400).json({ error: "agentType must be 'params' | 'summary' | 'route'" });
  }

  const message = String(req.body?.message ?? "").trim();
  if (!message) return res.status(400).json({ error: "Message required" });

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
    const messages = await svc.listMessages(threadId);
    const lastAssistant = getLastAssistantMessage(messages);

    res.json({ threadId, lastAssistant });
  } catch (e: any) {
    console.error("POST /node/agent/send error:", e);
    res.status(500).json({ error: e?.message ?? "Internal Server Error" });
  }
});

async function bootstrap() {
  const projectUrl = process.env.AZURE_AI_PROJECT_URL || "";
  const paramAgentId = process.env.AZURE_Params_AGENT_ID || "";
  const summaryAgentId = process.env.AZURE_Summary_AGENT_ID || "";
  const routingAgentId = process.env.AZURE_Routing_AGENT_ID || "";

  if (!projectUrl || !paramAgentId || !summaryAgentId || !routingAgentId) {
    throw new Error("Missing env: AZURE_AI_PROJECT_URL or agent IDs");
  }

  const paramAgent = new AgentService({ projectUrl, agentId: paramAgentId });
  const summaryAgent = new AgentService({ projectUrl, agentId: summaryAgentId });
  const routingAgent = new AgentService({ projectUrl, agentId: routingAgentId });

  const [paramInfo, summaryInfo, routingInfo] = await Promise.all([
    paramAgent.ensureAgentReady(),
    summaryAgent.ensureAgentReady(),
    routingAgent.ensureAgentReady(),
  ]);

  console.log(`[bootstrap] ParamAgent ready: ${paramInfo.name} (${paramInfo.id})`);
  console.log(`[bootstrap] SummaryAgent ready: ${summaryInfo.name} (${summaryInfo.id})`);
  console.log(`[bootstrap] RoutingAgent ready: ${routingInfo.name} (${routingInfo.id})`);

  ctx.agentParams = paramAgent;
  ctx.agentSummary = summaryAgent;
  ctx.agentRouting = routingAgent;

  ctx.ready = true;
  console.log("[bootstrap] done");
}

function shutdown(signal: string) {
  console.log(`[shutdown] ${signal}`);
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

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
