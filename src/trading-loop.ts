import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { TradingAgent } from "./agent/decision-maker.js";
import { logger } from "./config/logger.js";
import { TaapiClient } from "./indicators/taapi-client.js";
import { HyperliquidApi } from "./trading/hyperliquid-api.js";
import type { ActiveTrade, AgentDecisionResult, CliArgs } from "./types/index.js";
import { jsonReplacer, roundOrNone, roundSeries } from "./utils/prompt-utils.js";

const DIARY_PATH = "diary.jsonl";

interface PricePoint {
  t: string;
  mid: number | null;
}

function getIntervalMs(interval: string): number {
  if (interval.endsWith("m")) return Number(interval.slice(0, -1)) * 60_000;
  if (interval.endsWith("h")) return Number(interval.slice(0, -1)) * 3_600_000;
  if (interval.endsWith("d")) return Number(interval.slice(0, -1)) * 86_400_000;
  throw new Error(`Unsupported interval: ${interval}`);
}

function isFailedOutputs(outputs: AgentDecisionResult | null | undefined): boolean {
  if (!outputs?.trade_decisions?.length) return true;
  return outputs.trade_decisions.every(
    (o: { action: string; rationale: string }) =>
      o.action === "hold" && o.rationale.toLowerCase().includes("parse error")
  );
}

function calculateSharpe(tradeLog: Array<{ pnl?: number }>): number {
  if (!tradeLog.length) return 0;
  const vals = tradeLog.map((r) => r.pnl ?? 0);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const variance = vals.reduce((sum, v) => sum + (v - mean) ** 2, 0) / vals.length;
  const std = variance > 0 ? Math.sqrt(variance) : 0;
  return std > 0 ? mean / std : 0;
}

export class TradingLoop {
  private readonly taapi = new TaapiClient();
  private readonly hyperliquid = new HyperliquidApi();
  private readonly agent = new TradingAgent();
  private readonly startTime = Date.now();
  private invocationCount = 0;
  private initialAccountValue: number | null = null;
  private readonly tradeLog: Array<Record<string, unknown>> = [];
  private readonly activeTrades: ActiveTrade[] = [];
  private readonly priceHistory = new Map<string, PricePoint[]>();
  private running = true;

  constructor(private readonly args: CliArgs) {}

  stop(): void {
    this.running = false;
  }

  async run(): Promise<void> {
    logger.info({ assets: this.args.assets, interval: this.args.interval }, "Starting trading loop");

    while (this.running) {
      this.invocationCount += 1;
      const minutesSinceStart = (Date.now() - this.startTime) / 60_000;

      try {
        await this.runOnce(minutesSinceStart);
      } catch (err) {
        logger.error({ err }, "Trading loop iteration failed");
      }

      await new Promise((r) => setTimeout(r, getIntervalMs(this.args.interval)));
    }
  }

  private async runOnce(minutesSinceStart: number): Promise<void> {
    const state = await this.hyperliquid.getUserState();
    const totalValue =
      state.total_value ||
      state.balance + state.positions.reduce((sum: number, p) => sum + (p.pnl ?? 0), 0);
    const sharpe = calculateSharpe(this.tradeLog as Array<{ pnl?: number }>);

    if (this.initialAccountValue === null) this.initialAccountValue = totalValue;
    const totalReturnPct = this.initialAccountValue
      ? ((totalValue - this.initialAccountValue) / this.initialAccountValue) * 100
      : 0;

    const positions = await Promise.all(
      state.positions.map(async (pos) => {
        const coin = pos.coin;
        const currentPx = coin ? await this.hyperliquid.getCurrentPrice(coin) : null;
        return {
          symbol: coin,
          quantity: roundOrNone(pos.szi, 6),
          entry_price: roundOrNone(pos.entryPx, 2),
          current_price: roundOrNone(currentPx, 2),
          liquidation_price: roundOrNone(pos.liquidationPx ?? pos.liqPx, 2),
          unrealized_pnl: roundOrNone(pos.pnl, 4),
          leverage: pos.leverage,
        };
      })
    );

    const recentDiary = this.readRecentDiary(10);
    const openOrders = await this.hyperliquid.getOpenOrders();
    const openOrdersStruct = openOrders.slice(0, 50).map((o: { coin?: string; oid?: number; isBuy?: boolean; sz?: number; px?: number; triggerPx?: number; orderType?: unknown }) => ({
      coin: o.coin,
      oid: o.oid,
      is_buy: o.isBuy,
      size: roundOrNone(o.sz, 6),
      price: roundOrNone(o.px, 2),
      trigger_price: roundOrNone(o.triggerPx, 2),
      order_type: o.orderType,
    }));

    this.reconcileActiveTrades(state.positions, openOrders);
    const recentFillsStruct = await this.buildRecentFills();

    const dashboard = {
      total_return_pct: roundOrNone(totalReturnPct, 2),
      balance: roundOrNone(state.balance, 2),
      account_value: roundOrNone(totalValue, 2),
      sharpe_ratio: roundOrNone(sharpe, 3),
      positions,
      active_trades: this.activeTrades.map((tr) => ({
        asset: tr.asset,
        is_long: tr.is_long,
        amount: roundOrNone(tr.amount, 6),
        entry_price: roundOrNone(tr.entry_price, 2),
        tp_oid: tr.tp_oid,
        sl_oid: tr.sl_oid,
        exit_plan: tr.exit_plan,
        opened_at: tr.opened_at,
      })),
      open_orders: openOrdersStruct,
      recent_diary: recentDiary,
      recent_fills: recentFillsStruct,
    };

    const marketSections = [];
    const assetPrices = new Map<string, number>();

    for (const asset of this.args.assets) {
      try {
        const currentPrice = await this.hyperliquid.getCurrentPrice(asset);
        assetPrices.set(asset, currentPrice);
        const history = this.priceHistory.get(asset) ?? [];
        history.push({ t: new Date().toISOString(), mid: roundOrNone(currentPrice, 2) });
        if (history.length > 60) history.shift();
        this.priceHistory.set(asset, history);

        const oi = await this.hyperliquid.getOpenInterest(asset);
        const funding = await this.hyperliquid.getFundingRate(asset);
        const intradayTf = "5m";

        const emaSeries = await this.taapi.fetchSeries("ema", `${asset}/USDT`, intradayTf, 10, { period: 20 });
        const macdSeries = await this.taapi.fetchSeries("macd", `${asset}/USDT`, intradayTf, 10, null, "valueMACD");
        const rsi7Series = await this.taapi.fetchSeries("rsi", `${asset}/USDT`, intradayTf, 10, { period: 7 });
        const rsi14Series = await this.taapi.fetchSeries("rsi", `${asset}/USDT`, intradayTf, 10, { period: 14 });

        const ltEma20 = await this.taapi.fetchValue("ema", `${asset}/USDT`, "4h", { period: 20 });
        const ltEma50 = await this.taapi.fetchValue("ema", `${asset}/USDT`, "4h", { period: 50 });
        const ltAtr3 = await this.taapi.fetchValue("atr", `${asset}/USDT`, "4h", { period: 3 });
        const ltAtr14 = await this.taapi.fetchValue("atr", `${asset}/USDT`, "4h", { period: 14 });
        const ltMacdSeries = await this.taapi.fetchSeries("macd", `${asset}/USDT`, "4h", 10, null, "valueMACD");
        const ltRsiSeries = await this.taapi.fetchSeries("rsi", `${asset}/USDT`, "4h", 10, { period: 14 });

        const recentMids = history.slice(-10).map((entry) => entry.mid);
        const fundingAnnualized = funding ? roundOrNone(funding * 24 * 365 * 100, 2) : null;

        marketSections.push({
          asset,
          current_price: roundOrNone(currentPrice, 2),
          intraday: {
            ema20: roundOrNone(emaSeries.at(-1), 2),
            macd: roundOrNone(macdSeries.at(-1), 2),
            rsi7: roundOrNone(rsi7Series.at(-1), 2),
            rsi14: roundOrNone(rsi14Series.at(-1), 2),
            series: {
              ema20: roundSeries(emaSeries, 2),
              macd: roundSeries(macdSeries, 2),
              rsi7: roundSeries(rsi7Series, 2),
              rsi14: roundSeries(rsi14Series, 2),
            },
          },
          long_term: {
            ema20: roundOrNone(ltEma20, 2),
            ema50: roundOrNone(ltEma50, 2),
            atr3: roundOrNone(ltAtr3, 2),
            atr14: roundOrNone(ltAtr14, 2),
            macd_series: roundSeries(ltMacdSeries, 2),
            rsi_series: roundSeries(ltRsiSeries, 2),
          },
          open_interest: roundOrNone(oi, 2),
          funding_rate: roundOrNone(funding, 8),
          funding_annualized_pct: fundingAnnualized,
          recent_mid_prices: recentMids,
        });
      } catch (err) {
        logger.error({ err, asset }, "Data gather error");
      }
    }

    const contextPayload = {
      invocation: {
        minutes_since_start: roundOrNone(minutesSinceStart, 2),
        current_time: new Date().toISOString(),
        invocation_count: this.invocationCount,
      },
      account: dashboard,
      market_data: marketSections,
      instructions: {
        assets: this.args.assets,
        requirement: "Decide actions for all assets and return a strict JSON array matching the schema.",
      },
    };

    const context = JSON.stringify(contextPayload, jsonReplacer);
    logger.info({ chars: context.length, assets: this.args.assets.length }, "Combined prompt built");
    appendFileSync(
      "prompts.log",
      `\n\n--- ${new Date().toISOString()} - ALL ASSETS ---\n${JSON.stringify(contextPayload, jsonReplacer, 2)}\n`
    );

    let outputs = await this.agent.decideTrade(this.args.assets, context);
    if (isFailedOutputs(outputs)) {
      logger.info("Retrying LLM once due to invalid/parse-error output");
      const retryContext = JSON.stringify(
        { retry_instruction: "Return ONLY the JSON array per schema with no prose.", original_context: contextPayload },
        jsonReplacer
      );
      outputs = await this.agent.decideTrade(this.args.assets, retryContext);
    }

    if (outputs.reasoning) logger.info({ reasoning: outputs.reasoning }, "LLM reasoning summary");

    for (const output of outputs.trade_decisions ?? []) {
      try {
        const asset = output.asset;
        if (!asset || !this.args.assets.includes(asset)) continue;
        const action = output.action;
        if (!action) continue;

        const currentPrice = assetPrices.get(asset) ?? 0;
        if (output.rationale) logger.info({ asset, rationale: output.rationale }, "Decision rationale");

        if (action === "buy" || action === "sell") {
          const isBuy = action === "buy";
          const allocUsd = Number(output.allocation_usd ?? 0);
          if (allocUsd <= 0) {
            logger.info({ asset }, "Holding: zero/negative allocation");
            continue;
          }
          if (!currentPrice) {
            logger.info({ asset }, "Skipping: missing current price");
            continue;
          }

          const amount = allocUsd / currentPrice;
          const exitPlan = output.exit_plan ?? "";
          const tpPrice = output.tp_price;
          const slPrice = output.sl_price;

          const order = isBuy
            ? await this.hyperliquid.placeBuyOrder(asset, amount)
            : await this.hyperliquid.placeSellOrder(asset, amount);

          await new Promise((r) => setTimeout(r, 1000));
          const fillsCheck = await this.hyperliquid.getRecentFills(10);
          const filled = fillsCheck.some((fc: { coin?: string; asset?: string }) => fc.coin === asset || fc.asset === asset);

          this.tradeLog.push({ type: action, price: currentPrice, amount, exit_plan: exitPlan, filled });

          let tpOid: number | null = null;
          let slOid: number | null = null;
          if (tpPrice) {
            const tpOrder = await this.hyperliquid.placeTakeProfit(asset, isBuy, amount, tpPrice);
            tpOid = this.hyperliquid.extractOids(tpOrder)[0] ?? null;
            logger.info({ asset, tpPrice }, "TP placed");
          }
          if (slPrice) {
            const slOrder = await this.hyperliquid.placeStopLoss(asset, isBuy, amount, slPrice);
            slOid = this.hyperliquid.extractOids(slOrder)[0] ?? null;
            logger.info({ asset, slPrice }, "SL placed");
          }

          for (let i = this.activeTrades.length - 1; i >= 0; i--) {
            if (this.activeTrades[i].asset === asset) this.activeTrades.splice(i, 1);
          }

          this.activeTrades.push({
            asset,
            is_long: isBuy,
            amount,
            entry_price: currentPrice,
            tp_oid: tpOid,
            sl_oid: slOid,
            exit_plan: exitPlan,
            opened_at: new Date().toISOString(),
          });

          logger.info({ action, asset, amount, currentPrice }, "Trade executed");
          appendFileSync(
            DIARY_PATH,
            `${JSON.stringify({
              timestamp: new Date().toISOString(),
              asset,
              action,
              allocation_usd: allocUsd,
              amount,
              entry_price: currentPrice,
              tp_price: tpPrice,
              tp_oid: tpOid,
              sl_price: slPrice,
              sl_oid: slOid,
              exit_plan: exitPlan,
              rationale: output.rationale,
              order_result: String(order),
              opened_at: new Date().toISOString(),
              filled,
            })}\n`
          );
        } else {
          logger.info({ asset, rationale: output.rationale }, "Hold");
          appendFileSync(
            DIARY_PATH,
            `${JSON.stringify({
              timestamp: new Date().toISOString(),
              asset,
              action: "hold",
              rationale: output.rationale,
            })}\n`
          );
        }
      } catch (err) {
        logger.error({ err, asset: output.asset }, "Execution error");
      }
    }
  }

  private readRecentDiary(limit: number): unknown[] {
    try {
      if (!existsSync(DIARY_PATH)) return [];
      const lines = readFileSync(DIARY_PATH, "utf8").split("\n").filter(Boolean);
      return lines.slice(-limit).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  }

  private reconcileActiveTrades(
    positions: Array<{ coin?: string; szi?: number }>,
    openOrders: Array<{ coin?: string }>
  ): void {
    try {
      const assetsWithPositions = new Set(
        positions.filter((p) => Math.abs(Number(p.szi ?? 0)) > 0).map((p) => p.coin)
      );
      const assetsWithOrders = new Set(openOrders.map((o) => o.coin).filter(Boolean));
      for (let i = this.activeTrades.length - 1; i >= 0; i--) {
        const tr = this.activeTrades[i];
        if (!assetsWithPositions.has(tr.asset) && !assetsWithOrders.has(tr.asset)) {
          logger.info({ asset: tr.asset }, "Reconciling stale active trade");
          this.activeTrades.splice(i, 1);
          appendFileSync(
            DIARY_PATH,
            `${JSON.stringify({
              timestamp: new Date().toISOString(),
              asset: tr.asset,
              action: "reconcile_close",
              reason: "no_position_no_orders",
              opened_at: tr.opened_at,
            })}\n`
          );
        }
      }
    } catch (err) {
      logger.error({ err }, "Reconciliation error");
    }
  }

  private async buildRecentFills(): Promise<unknown[]> {
    try {
      const fills = await this.hyperliquid.getRecentFills(50);
      return fills.slice(-20).map((f: { time?: number | string; timestamp?: number | string; coin?: string; asset?: string; isBuy?: boolean; sz?: number | string; size?: number | string; px?: number | string; price?: number | string }) => {
        const tRaw = f.time ?? f.timestamp;
        let timestamp: string | null = null;
        if (tRaw !== undefined) {
          const tInt = Number(tRaw);
          if (Number.isFinite(tInt)) {
            timestamp = new Date(tInt > 1e12 ? tInt : tInt * 1000).toISOString();
          } else {
            timestamp = String(tRaw);
          }
        }
        return {
          timestamp,
          coin: f.coin ?? f.asset,
          is_buy: f.isBuy,
          size: roundOrNone(f.sz ?? f.size, 6),
          price: roundOrNone(f.px ?? f.price, 2),
        };
      });
    } catch {
      return [];
    }
  }
}
