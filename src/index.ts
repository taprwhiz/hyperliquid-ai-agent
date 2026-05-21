import type { CliArgs } from "./types/index.js";

function parseCliArgs(argv: string[]): Partial<CliArgs> {
  const assets: string[] = [];
  let interval: string | undefined;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--assets") {
      while (argv[i + 1] && !argv[i + 1].startsWith("--")) {
        assets.push(argv[++i]);
      }
    } else if (arg === "--interval") {
      interval = argv[++i];
    }
  }

  return { assets: assets.length ? assets : undefined, interval };
}

function printHelp(): void {
  console.log(`usage: node dist/index.js [--assets BTC ETH] [--interval 1h]

LLM-based Trading Agent on Hyperliquid

options:
  --assets   Assets to trade, e.g., BTC ETH
  --interval Interval period, e.g., 1h, 5m
`);
}

function resolveArgs(settings: { assets?: string[]; interval?: string }): CliArgs {
  const cli = parseCliArgs(process.argv);
  const assets = cli.assets ?? settings.assets;
  const interval = cli.interval ?? settings.interval;

  if (!assets?.length || !interval) {
    console.error("Please provide --assets and --interval, or set ASSETS and INTERVAL in .env");
    process.exit(1);
  }

  return { assets, interval };
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp();
    return;
  }

  if (process.stdout.isTTY) {
    console.clear();
  }

  const { settings } = await import("./config/settings.js");
  const { logger } = await import("./config/logger.js");
  const { createApiApp } = await import("./api/server.js");
  const { serve } = await import("@hono/node-server");
  const { TradingLoop } = await import("./trading-loop.js");

  const args = resolveArgs(settings);
  logger.info({ assets: args.assets, interval: args.interval }, "Nocturne trading agent starting");

  const app = createApiApp();
  serve({ fetch: app.fetch, hostname: settings.apiHost, port: settings.apiPort }, () => {
    logger.info({ host: settings.apiHost, port: settings.apiPort }, "API server listening");
  });

  const loop = new TradingLoop(args);

  const shutdown = (signal: string) => {
    logger.info({ signal }, "Shutting down");
    loop.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await loop.run();
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
