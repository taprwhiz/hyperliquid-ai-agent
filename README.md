# LLM-based Trading Agent on Hyperliquid

## Structure
- `src/main.py`: Entry point, handles user input and main trading loop.
- `src/agent/decision_maker.py`: LLM logic for trade decisions (OpenRouter with tool calling for TAAPI indicators).
- `src/indicators/taapi_client.py`: Fetches indicators from TAAPI.
- `src/trading/hyperliquid_api.py`: Executes trades on Hyperliquid.
- `src/config_loader.py`: Centralized config loaded from `.env`.
- `tests/`: For unit tests (to be implemented).

## Env Configuration
Populate `.env` (use `.env.example` as reference):
- TAAPI_API_KEY
- HYPERLIQUID_PRIVATE_KEY (or LIGHTER_PRIVATE_KEY)
- OPENROUTER_API_KEY
- LLM_MODEL 
- Optional: OPENROUTER_BASE_URL (`https://openrouter.ai/api/v1`), OPENROUTER_REFERER, OPENROUTER_APP_TITLE

## Usage
Run: `poetry run python src/main.py --assets BTC ETH --interval 1h`

## First Principles
- Minimal surface area, modular components.
- Real APIs end-to-end (TAAPI, OpenRouter, Hyperliquid).
- Continuous loop, explicit logging.

## Tool Calling
The agent can dynamically fetch any TAAPI indicator (e.g., EMA, RSI) via tool calls. See [TAAPI Indicators](https://taapi.io/indicators/) and [EMA Example](https://taapi.io/indicators/exponential-moving-average/) for details.
