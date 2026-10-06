// Both Groq and Gemini expose an OpenAI-compatible /chat/completions endpoint,
// so one request shape works for either provider. This is what makes the
// fallback below a ~20-line function instead of two separate SDKs to reconcile.

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

interface LLMResponse {
  content: string | null;
  toolCalls: ToolCall[] | null;
  finishReason: string;
}

interface Provider {
  name: string;
  url: string;
  apiKey: string | undefined;
  model: string;
}

const PROVIDERS: Provider[] = [
  {
    name: "groq",
    url: "https://api.groq.com/openai/v1/chat/completions",
    apiKey: process.env.GROQ_API_KEY,
    model: process.env.GROQ_MODEL || "openai/gpt-oss-120b",
  },
  {
    name: "gemini",
    url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    apiKey: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
  },
].filter((p) => !!p.apiKey);

if (PROVIDERS.length === 0) {
  console.warn("No LLM provider API keys set — set GROQ_API_KEY (and optionally GEMINI_API_KEY) in .env");
}

// Simple in-memory circuit breaker per provider: after 3 consecutive failures,
// skip it for 30s instead of paying the timeout cost on every request.
const breaker = new Map<string, { failures: number; openUntil: number }>();

function isOpen(name: string): boolean {
  const state = breaker.get(name);
  return !!state && state.openUntil > Date.now();
}

function recordFailure(name: string) {
  const state = breaker.get(name) ?? { failures: 0, openUntil: 0 };
  state.failures += 1;
  if (state.failures >= 3) {
    state.openUntil = Date.now() + 30_000;
    state.failures = 0;
  }
  breaker.set(name, state);
}

function recordSuccess(name: string) {
  breaker.set(name, { failures: 0, openUntil: 0 });
}

async function callProvider(
  provider: Provider,
  messages: ChatMessage[],
  tools: ToolDef[],
  timeoutMs: number
): Promise<LLMResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(provider.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify({
        model: provider.model,
        messages,
        tools,
        tool_choice: "auto",
        temperature: 0.2, // low temperature: this is a factual/task agent, not a creative one
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`${provider.name} responded ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as {
      choices: { message: { content: string | null; tool_calls?: ToolCall[] }; finish_reason: string }[];
    };
    const choice = data.choices[0];
    return {
      content: choice.message.content ?? null,
      toolCalls: choice.message.tool_calls ?? null,
      finishReason: choice.finish_reason,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Calls the first healthy provider, retrying once on transient failure,
 * then falling over to the next configured provider. Throws only if every
 * provider fails — the caller (orchestrator) is responsible for the
 * user-facing fallback message at that point.
 */
export async function chatCompletion(
  messages: ChatMessage[],
  tools: ToolDef[],
  { timeoutMs = 8000, retries = 1 }: { timeoutMs?: number; retries?: number } = {}
): Promise<LLMResponse> {
  let lastError: unknown;

  for (const provider of PROVIDERS) {
    if (isOpen(provider.name)) continue;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const result = await callProvider(provider, messages, tools, timeoutMs);
        recordSuccess(provider.name);
        return result;
      } catch (err) {
        lastError = err;
        console.error(`[llm] ${provider.name} attempt ${attempt + 1} failed:`, (err as Error).message);
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, 300 * 2 ** attempt)); // exponential backoff
        }
      }
    }
    recordFailure(provider.name);
  }

  throw new Error(`All LLM providers failed: ${(lastError as Error)?.message ?? "unknown error"}`);
}
