import "dotenv/config";
import { Wallet } from "ethers";
import { z } from "zod";

const PLACEHOLDER_PATTERNS = [
  /your_.*_here/i,
  /replace[_-]?me/i,
  /changeme/i,
  /xxx+/i,
];

function looksLikePlaceholder(value: string): boolean {
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(value.trim()));
}

function normalizePrivateKey(raw: string | undefined, envName: string): string | undefined {
  if (!raw || raw.trim() === "") return undefined;
  const value = raw.trim();
  if (looksLikePlaceholder(value)) {
    throw new Error(
      `${envName} still contains a placeholder value. Set a real 32-byte hex private key before starting the agent.`
    );
  }
  const normalized = value.toLowerCase().startsWith("0x") ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error(
      `Invalid ${envName}: expected 64 hex characters (optional 0x prefix), got ${normalized.length} characters.`
    );
  }
  return `0x${normalized.toLowerCase()}`;
}

function parseJsonObject(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw || raw.trim() === "") return undefined;
  const parsed = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Environment variable must be a JSON object: ${raw}`);
  }
  return parsed as Record<string, unknown>;
}

function parseStringList(raw: string | undefined): string[] | undefined {
  if (!raw || raw.trim() === "") return undefined;
  const trimmed = raw.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
      throw new Error(`Environment variable must be a JSON list: ${raw}`);
    }
    return parsed.map((item) => String(item).trim()).filter(Boolean);
  }
  return trimmed
    .split(",")
    .map((item) => item.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

function parseAssets(raw: string | undefined): string[] | undefined {
  if (!raw || raw.trim() === "") return undefined;
  if (raw.includes(",")) {
    return raw.split(",").map((a) => a.trim()).filter(Boolean);
  }
  return raw.split(/\s+/).map((a) => a.trim()).filter(Boolean);
}

const rawSchema = z.object({
  TAAPI_API_KEY: z.string().min(1, "TAAPI_API_KEY is required"),
  HYPERLIQUID_PRIVATE_KEY: z.string().optional(),
  LIGHTER_PRIVATE_KEY: z.string().optional(),
  MNEMONIC: z.string().optional(),
  HYPERLIQUID_NETWORK: z.enum(["mainnet", "testnet"]).default("mainnet"),
  HYPERLIQUID_BASE_URL: z.string().optional(),
  OPENROUTER_API_KEY: z.string().min(1, "OPENROUTER_API_KEY is required"),
  OPENROUTER_BASE_URL: z.string().default("https://openrouter.ai/api/v1"),
  OPENROUTER_REFERER: z.string().optional(),
  OPENROUTER_APP_TITLE: z.string().default("trading-agent"),
  LLM_MODEL: z.string().default("x-ai/grok-4"),
  SANITIZE_MODEL: z.string().default("openai/gpt-5"),
  REASONING_ENABLED: z
    .string()
    .optional()
    .transform((v) => ["1", "true", "yes", "on"].includes((v ?? "").trim().toLowerCase())),
  REASONING_EFFORT: z.string().default("high"),
  PROVIDER_CONFIG: z.string().optional(),
  PROVIDER_QUANTIZATIONS: z.string().optional(),
  ASSETS: z.string().optional(),
  INTERVAL: z.string().optional(),
  API_HOST: z.string().default("0.0.0.0"),
  APP_PORT: z.string().optional(),
  API_PORT: z.string().optional(),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
});

function loadSettings() {
  const parsed = rawSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid environment configuration:");
    console.error(parsed.error.flatten().fieldErrors);
    process.exit(1);
  }

  const env = parsed.data;
  const privateKey = normalizePrivateKey(
    env.HYPERLIQUID_PRIVATE_KEY ?? env.LIGHTER_PRIVATE_KEY,
    "HYPERLIQUID_PRIVATE_KEY"
  );

  if (!privateKey && !(env.MNEMONIC && env.MNEMONIC.trim())) {
    console.error("Either HYPERLIQUID_PRIVATE_KEY/LIGHTER_PRIVATE_KEY or MNEMONIC must be provided");
    process.exit(1);
  }

  const walletAddress = privateKey ? new Wallet(privateKey).address : undefined;
  const apiPort = Number(env.APP_PORT ?? env.API_PORT ?? "3000");

  return {
    taapiApiKey: env.TAAPI_API_KEY,
    hyperliquidPrivateKey: privateKey,
    mnemonic: env.MNEMONIC?.trim() || undefined,
    hyperliquidNetwork: env.HYPERLIQUID_NETWORK,
    hyperliquidTestnet: env.HYPERLIQUID_NETWORK === "testnet",
    hyperliquidBaseUrl: env.HYPERLIQUID_BASE_URL,
    walletAddress,
    openrouterApiKey: env.OPENROUTER_API_KEY,
    openrouterBaseUrl: env.OPENROUTER_BASE_URL.replace(/\/$/, ""),
    openrouterReferer: env.OPENROUTER_REFERER,
    openrouterAppTitle: env.OPENROUTER_APP_TITLE,
    llmModel: env.LLM_MODEL,
    sanitizeModel: env.SANITIZE_MODEL,
    reasoningEnabled: env.REASONING_ENABLED,
    reasoningEffort: env.REASONING_EFFORT,
    providerConfig: parseJsonObject(env.PROVIDER_CONFIG),
    providerQuantizations: parseStringList(env.PROVIDER_QUANTIZATIONS),
    assets: parseAssets(env.ASSETS),
    interval: env.INTERVAL,
    apiHost: env.API_HOST,
    apiPort,
    logLevel: env.LOG_LEVEL,
  };
}

export type Settings = ReturnType<typeof loadSettings>;
export const settings = loadSettings();
