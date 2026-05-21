import { Hyperliquid } from "hyperliquid";
import { Wallet } from "ethers";
import { settings } from "../config/settings.js";
import { logger } from "../config/logger.js";
import type { EnrichedPosition, FillEntry, OpenOrder, UserState } from "../types/index.js";

type MetaCache = [{ universe: Array<{ name: string; szDecimals?: number }> }, Array<{ openInterest?: string; funding?: string }>];

export class HyperliquidApi {
  private readonly sdk: Hyperliquid;
  private readonly walletAddress: string;
  private metaCache: MetaCache | null = null;
  private initialized = false;

  constructor() {
    if (!settings.hyperliquidPrivateKey) {
      throw new Error("Either HYPERLIQUID_PRIVATE_KEY/LIGHTER_PRIVATE_KEY or MNEMONIC must be provided");
    }
    this.walletAddress = new Wallet(settings.hyperliquidPrivateKey).address;
    this.sdk = new Hyperliquid({
      privateKey: settings.hyperliquidPrivateKey,
      testnet: settings.hyperliquidTestnet,
      walletAddress: this.walletAddress,
      enableWs: false,
    });
  }

  private async ensureInit(): Promise<void> {
    if (this.initialized) return;
    await this.sdk.ensureInitialized();
    this.initialized = true;
  }

  private async retry<T>(fn: () => Promise<T>, maxAttempts = 3, backoffBase = 500): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        await this.ensureInit();
        return await fn();
      } catch (err) {
        lastError = err;
        logger.warn({ attempt: attempt + 1, maxAttempts, err }, "Hyperliquid call failed");
        if (attempt < maxAttempts - 1) {
          await new Promise((r) => setTimeout(r, backoffBase * 2 ** attempt));
        }
      }
    }
    throw lastError ?? new Error("Hyperliquid retry: unknown error");
  }

  private async getMetaAndCtxs(): Promise<MetaCache> {
    if (!this.metaCache) {
      this.metaCache = (await this.retry(() =>
        this.sdk.info.perpetuals.getMetaAndAssetCtxs()
      )) as MetaCache;
    }
    return this.metaCache;
  }

  roundSize(asset: string, amount: number): number {
    const meta = this.metaCache?.[0];
    const assetInfo = meta?.universe.find((u) => u.name === asset);
    const decimals = assetInfo?.szDecimals ?? 8;
    const factor = 10 ** decimals;
    return Math.round(amount * factor) / factor;
  }

  async placeBuyOrder(asset: string, amount: number, slippage = 0.01): Promise<unknown> {
    const size = this.roundSize(asset, amount);
    return this.retry(() => this.sdk.custom.marketOpen(asset, true, size, undefined, slippage));
  }

  async placeSellOrder(asset: string, amount: number, slippage = 0.01): Promise<unknown> {
    const size = this.roundSize(asset, amount);
    return this.retry(() => this.sdk.custom.marketOpen(asset, false, size, undefined, slippage));
  }

  async placeTakeProfit(asset: string, isBuy: boolean, amount: number, tpPrice: number): Promise<unknown> {
    const size = this.roundSize(asset, amount);
    return this.retry(() =>
      this.sdk.exchange.placeOrder({
        coin: asset,
        is_buy: !isBuy,
        sz: size,
        limit_px: tpPrice,
        order_type: { trigger: { triggerPx: tpPrice, isMarket: true, tpsl: "tp" } },
        reduce_only: true,
      })
    );
  }

  async placeStopLoss(asset: string, isBuy: boolean, amount: number, slPrice: number): Promise<unknown> {
    const size = this.roundSize(asset, amount);
    return this.retry(() =>
      this.sdk.exchange.placeOrder({
        coin: asset,
        is_buy: !isBuy,
        sz: size,
        limit_px: slPrice,
        order_type: { trigger: { triggerPx: slPrice, isMarket: true, tpsl: "sl" } },
        reduce_only: true,
      })
    );
  }

  extractOids(orderResult: unknown): number[] {
    const oids: number[] = [];
    try {
      const result = orderResult as {
        response?: { data?: { statuses?: Array<Record<string, { oid?: number }>> } };
      };
      for (const st of result.response?.data?.statuses ?? []) {
        if (st.resting?.oid !== undefined) oids.push(st.resting.oid);
        if (st.filled?.oid !== undefined) oids.push(st.filled.oid);
      }
    } catch {
      // ignore malformed responses
    }
    return oids;
  }

  async getOpenOrders(): Promise<OpenOrder[]> {
    try {
      const orders = await this.retry(() =>
        this.sdk.info.getFrontendOpenOrders(this.walletAddress)
      );
      return (orders as Array<Record<string, unknown>>).map((o) => {
        const order: OpenOrder = {
          coin: o.coin as string,
          oid: o.oid as number,
          isBuy: o.side === "B" || o.isBuy === true,
          sz: parseFloat(String(o.sz ?? 0)),
          px: parseFloat(String(o.limitPx ?? o.px ?? 0)),
        };
        const ot = o.orderType as { trigger?: { triggerPx?: string } } | undefined;
        if (ot?.trigger?.triggerPx) {
          order.triggerPx = parseFloat(ot.trigger.triggerPx);
        }
        return order;
      });
    } catch (err) {
      logger.error({ err }, "Get open orders error");
      return [];
    }
  }

  async getRecentFills(limit = 50): Promise<FillEntry[]> {
    try {
      const fills = await this.retry(() => this.sdk.info.getUserFills(this.walletAddress));
      const list = Array.isArray(fills) ? fills : [];
      return list.slice(-limit) as FillEntry[];
    } catch (err) {
      logger.error({ err }, "Get recent fills error");
      return [];
    }
  }

  async getCurrentPrice(asset: string): Promise<number> {
    const mids = await this.retry(() => this.sdk.info.getAllMids());
    return parseFloat(String((mids as Record<string, string | number>)[asset] ?? 0));
  }

  async getUserState(): Promise<UserState> {
    const raw = await this.retry(() =>
      this.sdk.info.perpetuals.getClearinghouseState(this.walletAddress)
    );
    const state = raw as unknown as {
      accountValue?: string;
      withdrawable?: string;
      assetPositions?: Array<{
        position: {
          coin?: string;
          entryPx?: string;
          szi?: string;
          liquidationPx?: string;
          leverage?: unknown;
        };
      }>;
    };

    let totalValue = parseFloat(String(state.accountValue ?? 0));
    const enrichedPositions: EnrichedPosition[] = [];

    for (const posWrap of state.assetPositions ?? []) {
      const pos = posWrap.position;
      const entryPx = parseFloat(String(pos.entryPx ?? 0));
      const size = parseFloat(String(pos.szi ?? 0));
      const side = size > 0 ? "long" : "short";
      const currentPx = entryPx && size ? await this.getCurrentPrice(String(pos.coin)) : 0;
      const pnl =
        side === "long"
          ? (currentPx - entryPx) * Math.abs(size)
          : (entryPx - currentPx) * Math.abs(size);
      enrichedPositions.push({
        coin: String(pos.coin),
        szi: size,
        entryPx,
        pnl,
        liquidationPx: pos.liquidationPx ? parseFloat(String(pos.liquidationPx)) : null,
        leverage: pos.leverage,
      });
    }

    const balance = parseFloat(String(state.withdrawable ?? 0));
    if (!totalValue) {
      totalValue = balance + enrichedPositions.reduce((sum, p) => sum + Math.max(p.pnl, 0), 0);
    }

    return { balance, total_value: totalValue, positions: enrichedPositions };
  }

  async getOpenInterest(asset: string): Promise<number | null> {
    try {
      const [meta, assetCtxs] = await this.getMetaAndCtxs();
      const assetIdx = meta.universe.findIndex((u) => u.name === asset);
      if (assetIdx >= 0 && assetIdx < assetCtxs.length) {
        const oi = assetCtxs[assetIdx]?.openInterest;
        return oi ? Number(parseFloat(String(oi)).toFixed(2)) : null;
      }
      return null;
    } catch (err) {
      logger.error({ err, asset }, "OI fetch error");
      return null;
    }
  }

  async getFundingRate(asset: string): Promise<number | null> {
    try {
      const [meta, assetCtxs] = await this.getMetaAndCtxs();
      const assetIdx = meta.universe.findIndex((u) => u.name === asset);
      if (assetIdx >= 0 && assetIdx < assetCtxs.length) {
        const funding = assetCtxs[assetIdx]?.funding;
        return funding ? Number(parseFloat(String(funding)).toFixed(8)) : null;
      }
      return null;
    } catch (err) {
      logger.error({ err, asset }, "Funding fetch error");
      return null;
    }
  }
}
