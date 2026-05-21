import axios, { AxiosError } from "axios";
import { settings } from "../config/settings.js";
import { logger } from "../config/logger.js";

export class TaapiClient {
  private readonly apiKey = settings.taapiApiKey;
  private readonly baseUrl = "https://api.taapi.io/";

  private async getWithRetry<T>(url: string, params: Record<string, unknown>, retries = 3, backoff = 0.5): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const resp = await axios.get<T>(url, { params, timeout: 10_000 });
        return resp.data;
      } catch (err) {
        lastError = err;
        const axiosErr = err as AxiosError;
        const status = axiosErr.response?.status;
        if (status && status >= 500 && attempt < retries - 1) {
          const wait = backoff * 2 ** attempt;
          logger.warn({ status, wait }, "TAAPI server error, retrying");
          await new Promise((r) => setTimeout(r, wait * 1000));
          continue;
        }
        if (axiosErr.code === "ECONNABORTED" && attempt < retries - 1) {
          const wait = backoff * 2 ** attempt;
          logger.warn({ wait }, "TAAPI timeout, retrying");
          await new Promise((r) => setTimeout(r, wait * 1000));
          continue;
        }
        throw err;
      }
    }
    throw lastError ?? new Error("Max retries exceeded");
  }

  async fetchSeries(
    indicator: string,
    symbol: string,
    interval: string,
    results = 10,
    params: Record<string, unknown> | null = null,
    valueKey = "value"
  ): Promise<number[]> {
    try {
      const data = await this.getHistoricalIndicator(indicator, symbol, interval, results, params);
      if (data && typeof data === "object" && !Array.isArray(data)) {
        const record = data as Record<string, unknown>;
        const series = record[valueKey];
        if (Array.isArray(series)) {
          return series.map((v) => (typeof v === "number" ? Number(v.toFixed(4)) : Number(v)));
        }
        if ("error" in record) {
          logger.error({ indicator, symbol, interval, error: record.error }, "TAAPI error");
        }
      }
      return [];
    } catch (err) {
      const axiosErr = err as AxiosError;
      logger.error(
        {
          indicator,
          status: axiosErr.response?.status,
          message: axiosErr.message,
        },
        "TAAPI fetch_series exception"
      );
      return [];
    }
  }

  async fetchValue(
    indicator: string,
    symbol: string,
    interval: string,
    params: Record<string, unknown> | null = null,
    key = "value"
  ): Promise<number | null> {
    try {
      const baseParams: Record<string, unknown> = {
        secret: this.apiKey,
        exchange: "binance",
        symbol,
        interval,
      };
      if (params) Object.assign(baseParams, params);
      const data = await this.getWithRetry<Record<string, unknown>>(`${this.baseUrl}${indicator}`, baseParams);
      const val = data[key];
      return typeof val === "number" ? Number(val.toFixed(4)) : null;
    } catch {
      return null;
    }
  }

  async getHistoricalIndicator(
    indicator: string,
    symbol: string,
    interval: string,
    results = 10,
    params: Record<string, unknown> | null = null
  ): Promise<unknown> {
    const baseParams: Record<string, unknown> = {
      secret: this.apiKey,
      exchange: "binance",
      symbol,
      interval,
      results,
    };
    if (params) Object.assign(baseParams, params);
    return this.getWithRetry(`${this.baseUrl}${indicator}`, baseParams);
  }

  async fetchIndicatorTool(args: {
    indicator: string;
    symbol: string;
    interval: string;
    period?: number;
    backtrack?: number;
    other_params?: Record<string, unknown>;
  }): Promise<unknown> {
    const params: Record<string, unknown> = {
      secret: this.apiKey,
      exchange: "binance",
      symbol: args.symbol,
      interval: args.interval,
    };
    if (args.period !== undefined) params.period = args.period;
    if (args.backtrack !== undefined) params.backtrack = args.backtrack;
    if (args.other_params) Object.assign(params, args.other_params);
    return this.getWithRetry(`${this.baseUrl}${args.indicator}`, params);
  }
}
