# LLM-based Trading Agent on Hyperliquid

This project implements an AI-powered trading agent that leverages LLM models (via OpenRouter) to analyze real-time market data from TAAPI and CoinAPI, make informed trading decisions, and execute trades on the Hyperliquid decentralized exchange. The agent runs in a continuous loop, monitoring specified cryptocurrency assets at configurable intervals, using technical indicators to decide on buy/sell/hold actions, and manages positions with take-profit and stop-loss orders.

## Table of Contents

- [Structure](#structure)
- [Env Configuration](#env-configuration)
- [Usage](#usage)
- [Tool Calling](#tool-calling)
- [Deployment to EigenCloud](#deployment-to-eigencloud)

## Structure
- `src/main.py`: Entry point, handles user input and main trading loop.
- `src/agent/decision_maker.py`: LLM logic for trade decisions (OpenRouter with tool calling for TAAPI indicators).
- `src/indicators/taapi_client.py`: Fetches indicators from TAAPI.
- `src/trading/hyperliquid_api.py`: Executes trades on Hyperliquid.
- `src/config_loader.py`: Centralized config loaded from `.env`.

## Env Configuration
Populate `.env` (use `.env.example` as reference):
- TAAPI_API_KEY
- HYPERLIQUID_PRIVATE_KEY (or LIGHTER_PRIVATE_KEY)
- OPENROUTER_API_KEY
- LLM_MODEL 
- Optional: OPENROUTER_BASE_URL (`https://openrouter.ai/api/v1`), OPENROUTER_REFERER, OPENROUTER_APP_TITLE
- COINAPI_KEY 

### Obtaining API Keys
- **TAAPI_API_KEY**: Sign up at [TAAPI.io](https://taapi.io/) and generate an API key from your dashboard.
- **HYPERLIQUID_PRIVATE_KEY**: Generate an Ethereum-compatible private key for Hyperliquid. Use tools like MetaMask or `eth_account` library. For security, never share this key. Alternatively, in Eigencloud deployments, use the auto-provided MNEMONIC.
- **OPENROUTER_API_KEY**: Create an account at [OpenRouter.ai](https://openrouter.ai/), then generate an API key in your account settings.
- **COINAPI_KEY**: Register at [CoinAPI.io](https://www.coinapi.io/) and obtain a free or paid API key depending on your usage needs.
- **LLM_MODEL**: No key needed; specify a model name like "x-ai/grok-4" (see OpenRouter models list).

## Usage
Run: `poetry run python src/main.py --assets BTC ETH --interval 1h`

## Tool Calling
The agent can dynamically fetch any TAAPI indicator (e.g., EMA, RSI) via tool calls. See [TAAPI Indicators](https://taapi.io/indicators/) and [EMA Example](https://taapi.io/indicators/exponential-moving-average/) for details.

## Deployment to EigenCloud

EigenCloud (via EigenX CLI) allows deploying this trading agent in a Trusted Execution Environment (TEE) with secure key management.

### Prerequisites
- Allowlisted Ethereum account (Sepolia for testnet). Request onboarding at [Eigencloud Onboarding](https://onboarding.eigencloud.xyz).
- Docker installed.
- Sepolia ETH for deployments.

### Installation
#### macOS/Linux
```bash
curl -fsSL https://eigenx-scripts.s3.us-east-1.amazonaws.com/install-eigenx.sh | bash
```

#### Windows
```bash
curl -fsSL https://eigenx-scripts.s3.us-east-1.amazonaws.com/install-eigenx.ps1 | powershell -
```

### Initial Setup
```bash
docker login
eigenx auth login  # Or eigenx auth generate --store (if you don't have a eth account, keep this account separate from your trading account)
```

### Deploy the Agent
From the project directory:
```bash
cp .env.example .env
# Edit .env: set ASSETS, INTERVAL, API keys
eigenx app deploy
```

### Monitoring
```bash
eigenx app info --watch
eigenx app logs --watch
```

### Updates
Edit code or .env, then:
```bash
eigenx app upgrade <app-name>
```

For full CLI reference, see the [EigenX Documentation](https://github.com/Layr-Labs/eigenx-cli).
