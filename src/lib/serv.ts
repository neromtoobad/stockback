import OpenAI from "openai";
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

// SERV Reasoning is OpenAI-wire-compatible; only the base URL and key change.
const client = new OpenAI({
  baseURL: "https://inference-api.openserv.ai/v1",
  apiKey: process.env.SERV_API_KEY ?? "missing",
  timeout: 120_000,
  maxRetries: 1,
});

export type ServFeature = "prompt_guard" | "shadow_agent" | "multipath" | "kronos" | "json_schema" | "vision";

export type ServTrace = {
  step: string;
  model: string;
  features: ServFeature[];
  latencyMs: number;
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
};

type ShadowOpts = { hint?: string; maxIterations?: number };

// SERV Tools are declared as ordinary function tools named serv_*; SERV strips them
// before the model runs and reads configuration from the schema defaults.
function servTools(opts: { promptGuard?: boolean; shadow?: ShadowOpts | false }): ChatCompletionTool[] {
  const tools: ChatCompletionTool[] = [];
  if (opts.promptGuard) tools.push({ type: "function", function: { name: "serv_prompt_guard" } });
  if (opts.shadow) {
    const properties: Record<string, unknown> = {};
    if (opts.shadow.hint) properties.hint = { type: "string", default: opts.shadow.hint };
    if (opts.shadow.maxIterations) properties.max_iterations = { type: "integer", default: opts.shadow.maxIterations };
    tools.push({
      type: "function",
      function: {
        name: "serv_shadow_agent",
        description: "Enable SERV shadow-agent validation.",
        parameters: { type: "object", properties },
      },
    });
  }
  return tools;
}

export async function servJson<T>(args: {
  step: string;
  model: string;
  system: string;
  user: OpenAI.Chat.Completions.ChatCompletionUserMessageParam["content"];
  schemaName: string;
  schema: Record<string, unknown>;
  reasoningEffort?: "none" | "low" | "medium" | "high";
  promptGuard?: boolean;
  shadow?: ShadowOpts | false;
}): Promise<{ data: T; trace: ServTrace }> {
  const tools = servTools({ promptGuard: args.promptGuard, shadow: args.shadow });
  const body: ChatCompletionCreateParamsNonStreaming = {
    model: args.model,
    messages: [
      { role: "system", content: args.system },
      { role: "user", content: args.user },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: args.schemaName, strict: true, schema: args.schema },
    },
    // SERV has been seen deriving an output limit above the model's 128K max (HTTP 400),
    // so pin a generous ceiling explicitly. Real outputs here are a few hundred tokens.
    max_completion_tokens: 16_000,
    ...(args.reasoningEffort ? { reasoning_effort: args.reasoningEffort as "low" } : {}),
    ...(tools.length ? { tools } : {}),
  };

  const started = Date.now();
  let res = await client.chat.completions.create(body);
  // An empty completion has been seen once on a cold reasoning prompt; one retry clears it.
  if (!res.choices[0]?.message?.content && !res.choices[0]?.message?.refusal) {
    console.warn("[serv] empty completion, retrying", args.step);
    res = await client.chat.completions.create(body);
  }
  const latencyMs = Date.now() - started;

  const choice = res.choices[0];
  const content = choice?.message?.content;
  if (!content) {
    const refusal = choice?.message?.refusal;
    console.error("[serv] empty content", args.step, JSON.stringify(res).slice(0, 1500));
    throw new ServError(
      refusal ? `SERV refused: ${refusal}` : `SERV returned no content for ${args.step} (finish_reason=${choice?.finish_reason ?? "unknown"})`,
    );
  }
  let data: T;
  try {
    data = JSON.parse(content) as T;
  } catch {
    throw new ServError(`SERV returned non-JSON content for ${args.step}`);
  }

  const features: ServFeature[] = ["json_schema"];
  if (Array.isArray(args.user) && args.user.some((p) => p.type === "image_url")) features.push("vision");
  if (args.promptGuard) features.push("prompt_guard");
  if (args.shadow) features.push("shadow_agent");
  if (args.model.includes("multipath")) features.push("multipath");
  if (args.model.includes("kronos")) features.push("kronos");

  return {
    data,
    trace: {
      step: args.step,
      model: args.model,
      features,
      latencyMs,
      promptTokens: res.usage?.prompt_tokens,
      completionTokens: res.usage?.completion_tokens,
      reasoningTokens: res.usage?.completion_tokens_details?.reasoning_tokens,
    },
  };
}

export class ServError extends Error {}
