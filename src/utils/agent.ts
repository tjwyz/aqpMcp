// src/Agent.ts
import { AIProjectClient } from "@azure/ai-projects";
import { DefaultAzureCredential } from "@azure/identity";

export type AgentDeps = {
  projectUrl: string;
  agentId: string;
};

export type PlainMessage = {
  id: string;
  role: string;
  text?: string;
  createdAt?: string;
};

export class AgentService {
  private client: AIProjectClient;
  private agentId: string;

  constructor({ projectUrl, agentId }: AgentDeps) {
    this.client = new AIProjectClient(projectUrl, new DefaultAzureCredential());
    this.agentId = agentId;
  }

  /** 启动时校验 agent 是否可用，并以返回的 id 兜底。 */
  async ensureAgentReady(): Promise<{ id: string; name?: string }> {
    const agent = await this.client.agents.getAgent(this.agentId);
    this.agentId = agent.id; // 以真实 id 为准
    return { id: agent.id, name: (agent as any).name };
  }

  /** 创建新线程 */
  async createThread(): Promise<{ id: string }> {
    const t = await this.client.agents.threads.create();
    return { id: t.id };
  }

  /** 仅拉取历史消息（升序） */
  async listMessages(threadId: string): Promise<PlainMessage[]> {
    const iter = this.client.agents.messages.list(threadId, { order: "asc" });
    const out: PlainMessage[] = [];
    for await (const m of iter) {
      const text = (m.content.find((c: any) => c.type === "text") as any)?.text?.value;
      out.push({
        id: m.id,
        role: m.role,
        text,
        createdAt: (m as any).createdAt,
      });
    }
    return out;
  }

  /** 在线程里追加一条用户消息 + 触发 run + 等待完成 */
  async appendAndRun(threadId: string, message: string, pollMs = 1000, timeoutMs = 120_000) {
    if (!message?.trim()) throw new Error("message is empty");
    // 1) 追加消息
    await this.client.agents.messages.create(threadId, "user", message);
    // 2) 创建 run
    const run = await this.client.agents.runs.create(threadId, this.agentId);
    // 3) 轮询直到完成
    const end = Date.now() + timeoutMs;
    let cur = await this.client.agents.runs.get(threadId, run.id);
    while ((cur.status === "queued" || cur.status === "in_progress") && Date.now() < end) {
      await new Promise(r => setTimeout(r, pollMs));
      cur = await this.client.agents.runs.get(threadId, run.id);
    }
    if (cur.status === "failed") {
      const err = (cur as any).lastError;
      throw new Error(`run failed: ${JSON.stringify(err)}`);
    }
    return { runId: cur.id, status: cur.status };
  }
}
