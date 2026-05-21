import axios, { AxiosError } from "axios";
import { appendFileSync } from "node:fs";
import { settings } from "../config/settings.js";
import { logger } from "../config/logger.js";
import { TaapiClient } from "../indicators/taapi-client.js";
import type { AgentDecisionResult, TradeDecision } from "../types/index.js";

type ChatMessage = Record<string, unknown>;

export class TradingAgent {
  private readonly model = settings.llmModel;
  private readonly apiKey = settings.openrouterApiKey;
  private readonly baseUrl = `${settings.openrouterBaseUrl}/chat/completions`;
  private readonly referer = settings.openrouterReferer;
  private readonly appTitle = settings.openrouterAppTitle;
  private readonly sanitizeModel = settings.sanitizeModel;
  private readonly taapi = new TaapiClient();

  async decideTrade(assets: string[], context: string): Promise<AgentDecisionResult> {
    return this.decide(context, assets);
  }

  private async decide(context: string, assets: string[]): Promise<AgentDecisionResult> {
    const systemPrompt = this.buildSystemPrompt(assets);
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: context },
    ];

    const tools = [
      {
        type: "function",
        function: {
          name: "fetch_taapi_indicator",
          description:
            'Fetch any TAAPI indicator. Available: ema, sma, rsi, macd, bbands, stochastic, stochrsi, adx, atr, cci, dmi, ichimoku, supertrend, vwap, obv, mfi, willr, roc, mom, sar (parabolic), fibonacci, pivotpoints, keltner, donchian, awesome, gator, alligator, and 200+ more. See https://taapi.io/indicators/ for full list and parameters.',
          parameters: {
            type: "object",
            properties: {
              indicator: { type: "string" },
              symbol: { type: "string" },
              interval: { type: "string" },
              period: { type: "integer" },
              backtrack: { type: "integer" },
              other_params: {
                type: "object",
                additionalProperties: { type: ["string", "number", "boolean"] },
              },
            },
            required: ["indicator", "symbol", "interval"],
            additionalProperties: false,
          },
        },
      },
    ];

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
    if (this.referer) headers["HTTP-Referer"] = this.referer;
    if (this.appTitle) headers["X-Title"] = this.appTitle;

    const post = (payload: Record<string, unknown>) => {
      logger.info({ model: payload.model }, "Sending request to OpenRouter");
      appendFileSync(
        "llm_requests.log",
        `\n\n=== ${new Date().toISOString()} ===\nModel: ${payload.model}\nPayload:\n${JSON.stringify(payload, null, 2)}\n`
      );
      return axios.post(this.baseUrl, payload, { headers, timeout: 60_000 }).then((resp) => {
        logger.info({ status: resp.status }, "Received response from OpenRouter");
        return resp.data;
      }).catch((err: AxiosError) => {
        const status = err.response?.status;
        const body = err.response?.data;
        logger.error({ status, body }, "OpenRouter error");
        appendFileSync("llm_requests.log", `ERROR Response: ${status} - ${JSON.stringify(body)}\n`);
        throw err;
      });
    };

    const holdAll = (reason: string): AgentDecisionResult => ({
      reasoning: reason,
      trade_decisions: assets.map((asset) => ({
        asset,
        action: "hold",
        allocation_usd: 0,
        tp_price: null,
        sl_price: null,
        exit_plan: "",
        rationale: reason,
      })),
    });

    const buildSchema = () => ({
      type: "object",
      properties: {
        reasoning: { type: "string" },
        trade_decisions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              asset: { type: "string", enum: assets },
              action: { type: "string", enum: ["buy", "sell", "hold"] },
              allocation_usd: { type: "number", minimum: 0 },
              tp_price: { type: ["number", "null"] },
              sl_price: { type: ["number", "null"] },
              exit_plan: { type: "string" },
              rationale: { type: "string" },
            },
            required: ["asset", "action", "allocation_usd", "tp_price", "sl_price", "exit_plan", "rationale"],
            additionalProperties: false,
          },
          minItems: 1,
        },
      },
      required: ["reasoning", "trade_decisions"],
      additionalProperties: false,
    });

    let allowTools = true;
    let allowStructured = true;

    for (let loop = 0; loop < 6; loop++) {
      const data: Record<string, unknown> = { model: this.model, messages };
      if (allowStructured) {
        data.response_format = {
          type: "json_schema",
          json_schema: { name: "trade_decisions", strict: true, schema: buildSchema() },
        };
      }
      if (allowTools) {
        data.tools = tools;
        data.tool_choice = "auto";
      }
      if (settings.reasoningEnabled) {
        data.reasoning = {
          enabled: true,
          effort: settings.reasoningEffort,
          exclude: false,
        };
      }
      if (settings.providerConfig || settings.providerQuantizations) {
        const providerPayload = { ...(settings.providerConfig ?? {}) };
        if (settings.providerQuantizations) {
          (providerPayload as Record<string, unknown>).quantizations = settings.providerQuantizations;
        }
        data.provider = providerPayload;
      }

      let respJson: Record<string, unknown>;
      try {
        respJson = await post(data);
      } catch (err) {
        const axiosErr = err as AxiosError<{ error?: { metadata?: { raw?: string; provider_name?: string } } }>;
        const status = axiosErr.response?.status;
        const errBody = axiosErr.response?.data ?? {};
        const raw = errBody.error?.metadata?.raw ?? "";
        const provider = errBody.error?.metadata?.provider_name ?? "";
        const errText = JSON.stringify(errBody);

        if (status === 422 && provider.toLowerCase().startsWith("xai") && raw.toLowerCase().includes("deserialize")) {
          logger.warn("xAI rejected tool schema; retrying without tools");
          if (allowTools) {
            allowTools = false;
            continue;
          }
        }
        if (allowStructured && (errText.includes("response_format") || errText.includes("structured") || status === 400 || status === 422)) {
          logger.warn("Provider rejected structured outputs; retrying without response_format");
          allowStructured = false;
          continue;
        }
        return holdAll(`LLM request failed (HTTP ${status ?? "unknown"})`);
      }

      const choice = (respJson.choices as Array<{ message: ChatMessage }>)[0];
      const message = choice.message;
      messages.push(message);

      const toolCalls = (message.tool_calls as Array<Record<string, unknown>> | undefined) ?? [];
      if (allowTools && toolCalls.length > 0) {
        for (const tc of toolCalls) {
          if (tc.type === "function" && (tc.function as { name?: string })?.name === "fetch_taapi_indicator") {
            const args = JSON.parse(String((tc.function as { arguments?: string }).arguments ?? "{}")) as {
              indicator: string;
              symbol: string;
              interval: string;
              period?: number;
              backtrack?: number;
              other_params?: Record<string, unknown>;
            };
            try {
              const indResp = await this.taapi.fetchIndicatorTool(args);
              messages.push({
                role: "tool",
                tool_call_id: tc.id,
                name: "fetch_taapi_indicator",
                content: JSON.stringify(indResp),
              });
            } catch (ex) {
              messages.push({
                role: "tool",
                tool_call_id: tc.id,
                name: "fetch_taapi_indicator",
                content: `Error: ${String(ex)}`,
              });
            }
          }
        }
        continue;
      }

      try {
        let parsed: AgentDecisionResult;
        if (message.parsed && typeof message.parsed === "object") {
          parsed = message.parsed as AgentDecisionResult;
        } else {
          parsed = JSON.parse(String(message.content ?? "{}")) as AgentDecisionResult;
        }

        if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.trade_decisions)) {
          return holdAll("Parse error");
        }

        const normalized: TradeDecision[] = parsed.trade_decisions.map((item) => ({
          asset: item.asset,
          action: item.action,
          allocation_usd: Number(item.allocation_usd ?? 0),
          tp_price: item.tp_price ?? null,
          sl_price: item.sl_price ?? null,
          exit_plan: item.exit_plan ?? "",
          rationale: item.rationale ?? "",
        }));

        return {
          reasoning: parsed.reasoning ?? "",
          trade_decisions: normalized,
        };
      } catch (err) {
        logger.error({ err, content: String(message.content ?? "").slice(0, 200) }, "JSON parse error");
        return holdAll("Parse error");
      }
    }

    return holdAll("tool loop cap");
  }

  private buildSystemPrompt(assets: string[]): string {
    return [
      "You are a rigorous QUANTITATIVE TRADER and interdisciplinary MATHEMATICIAN-ENGINEER optimizing risk-adjusted returns for perpetual futures under real execution, margin, and funding constraints.",
      "You will receive market + account context for SEVERAL assets, including:",
      `- assets = ${JSON.stringify(assets)}`,
      "- per-asset intraday (5m) and higher-timeframe (4h) metrics",
      "- Active Trades with Exit Plans",
      "- Recent Trading History",
      "",
      "Always use the 'current time' provided in the user message to evaluate any time-based conditions, such as cooldown expirations or timed exit plans.",
      "",
      "Your goal: make decisive, first-principles decisions per asset that minimize churn while capturing edge.",
      "",
      "Output a STRICT JSON object with exactly two properties: reasoning and trade_decisions.",
      "Each trade_decisions item must contain {asset, action, allocation_usd, tp_price, sl_price, exit_plan, rationale}.",
      "Do not emit Markdown or any extra properties.",
    ].join("\n");
  }
}
