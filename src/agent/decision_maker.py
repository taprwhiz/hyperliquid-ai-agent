import requests
from src.config_loader import CONFIG
from src.indicators.taapi_client import TAAPIClient
import json
import logging
from datetime import datetime

class TradingAgent:
    def __init__(self):
        self.model = CONFIG["llm_model"]
        self.api_key = CONFIG["openrouter_api_key"]
        base = CONFIG["openrouter_base_url"]
        self.base_url = f"{base}/chat/completions"
        self.referer = CONFIG.get("openrouter_referer")
        self.app_title = CONFIG.get("openrouter_app_title")
        self.taapi = TAAPIClient()

    def decide_trade_multi(self, assets, context):
        """Decide for multiple assets in one call. Returns list of dicts."""
        return self._decide(context, is_multi=True, assets=assets)

    def decide_trade(self, asset, context):
        """Legacy single-asset decision."""
        result = self._decide(context, is_multi=False, assets=[asset])
        return result[0] if result else {"action": "hold", "allocation_usd": 0.0, "tp_price": None, "sl_price": None, "exit_plan": "", "rationale": "Error"}

    def _decide(self, context, is_multi, assets):
        system_prompt = (
            "You are a rigorous quantitative trader and interdisciplinary mathematician-engineer optimizing risk-adjusted returns for perpetual futures on Hyperliquid under real execution, margin, and funding constraints.\n"
            "You will receive market + account context for SEVERAL assets, including:\n"
            f"- assets = {json.dumps(assets)}\n"
            "- per-asset intraday (5m) and higher-timeframe (4h) metrics\n"
            "- Active Trades with Exit Plans\n"
            "- Recent Trading History\n\n"
            "Always use the 'current time' provided in the user message to evaluate any time-based conditions, such as cooldown expirations or timed exit plans.\n\n"
            "Your goal: make decisive, first-principles decisions per asset that minimize churn while capturing edge.\n\n"
            "Core policy (low-churn, position-aware)\n"
            "1) Respect prior plans: If an active trade has an exit_plan with explicit invalidation (e.g., “close if 4h close above EMA50”), DO NOT close or flip early unless that invalidation (or a stronger one) has occurred.\n"
            "2) Hysteresis: Require stronger evidence to CHANGE a decision than to keep it. Only flip direction if BOTH:\n"
            "   a) Higher-timeframe structure supports the new direction (e.g., 4h EMA20 vs EMA50 and/or MACD regime), AND\n"
            "   b) Intraday structure confirms with a decisive break beyond ~0.5×ATR (recent) and momentum alignment (MACD or RSI slope).\n"
            "   Otherwise, prefer HOLD or adjust TP/SL.\n"
            "3) Cooldown: After opening, adding, reducing, or flipping, impose a self-cooldown of at least 3 bars of the decision timeframe (e.g., 3×5m = 15m) before another direction change, unless a hard invalidation occurs. Encode this in exit_plan (e.g., “cooldown_bars:3 until 2025-10-19T15:55Z”). You must honor your own cooldowns on future cycles.\n"
            "4) Funding is a tilt, not a trigger: Do NOT open/close/flip solely due to funding unless expected funding over your intended holding horizon meaningfully exceeds expected edge (e.g., > ~0.25×ATR). Consider that funding accrues discretely and slowly relative to 5m bars.\n"
            "5) Overbought/oversold ≠ reversal by itself: Treat RSI extremes as risk-of-pullback. You need structure + momentum confirmation to bet against trend. Prefer tightening stops or taking partial profits over instant flips.\n"
            "6) Prefer adjustments over exits: If the thesis weakens but is not invalidated, first consider: tighten stop (e.g., to a recent swing or ATR multiple), trail TP, or reduce size. Flip only on hard invalidation + fresh confluence.\n\n"
            "Decision discipline (per asset)\n"
            "- Choose one: buy / sell / hold.\n"
            "- You control allocation_usd.\n"
            "- TP/SL sanity:\n"
            "  • BUY: tp_price > current_price, sl_price < current_price\n"
            "  • SELL: tp_price < current_price, sl_price > current_price\n"
            "  If sensible TP/SL cannot be set, use null and explain the logic.\n"
            "- exit_plan must include at least ONE explicit invalidation trigger and may include cooldown guidance you will follow later.\n\n"
            "Leverage policy (perpetual futures)\n"
            "- YOU CAN USE LEVERAGE, KEEP IT WITHIN 5X IN TOTAL\n"
            "- In high volatility (elevated ATR) or during funding spikes, reduce or avoid leverage.\n"
            "- Treat allocation_usd as notional exposure; keep it consistent with safe leverage and available margin.\n\n"
            "Tool usage\n"
            "- Call fetch_taapi_indicator ONLY if one specific reading would materially change your decision. Keep parameters minimal (indicator, symbol like \"BTC/USDT\", interval \"5m\"/\"4h\", optional period).\n\n"
            "- Tool usage is recommended, in case you don't feel confident enough with provided indicators or if you want more information."
            "Reasoning recipe (first principles)\n"
            "- Structure (trend, EMAs slope/cross, HH/HL vs LH/LL), Momentum (MACD regime, RSI slope), Liquidity/volatility (ATR, volume), Positioning tilt (funding, OI).\n"
            "- Favor alignment across 4h and 5m. Counter-trend scalps require stronger intraday confirmation and tighter risk.\n\n"
            "Output contract\n"
            "- Output STRICT JSON array (no Markdown, no extra text), one object per asset in the SAME ORDER as the provided assets list.\n"
            "- Exact keys for each object: {asset, action, allocation_usd, tp_price, sl_price, exit_plan, rationale}\n"
        )
        user_prompt = context
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ]

        tools = [{
            "type": "function",
            "function": {
                "name": "fetch_taapi_indicator",
                "description": ("Fetch any TAAPI indicator. Available: ema, sma, rsi, macd, bbands, stochastic, stochrsi, "
                    "adx, atr, cci, dmi, ichimoku, supertrend, vwap, obv, mfi, willr, roc, mom, sar (parabolic), "
                    "fibonacci, pivotpoints, keltner, donchian, awesome, gator, alligator, and 200+ more. "
                    "See https://taapi.io/indicators/ for full list and parameters."),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "indicator": {"type": "string"},
                        "symbol": {"type": "string"},
                        "interval": {"type": "string"},
                        "period": {"type": "integer"},
                        "backtrack": {"type": "integer"},
                        "other_params": {"type": "object", "additionalProperties": {"type": ["string", "number", "boolean"]}},
                    },
                    "required": ["indicator", "symbol", "interval"],
                    "additionalProperties": False,
                },
            },
        }]

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        if self.referer:
            headers["HTTP-Referer"] = self.referer
        if self.app_title:
            headers["X-Title"] = self.app_title

        def _post(payload):
            # Log the full request payload for debugging
            logging.info(f"Sending request to OpenRouter (model: {payload.get('model')})")
            with open("llm_requests.log", "a") as f:
                f.write(f"\n\n=== {datetime.now()} ===\n")
                f.write(f"Model: {payload.get('model')}\n")
                f.write(f"Headers: {json.dumps({k: v for k, v in headers.items() if k != 'Authorization'})}\n")
                f.write(f"Payload:\n{json.dumps(payload, indent=2)}\n")
            resp = requests.post(self.base_url, headers=headers, json=payload, timeout=60)
            logging.info(f"Received response from OpenRouter (status: {resp.status_code})")
            if resp.status_code != 200:
                logging.error(f"OpenRouter error: {resp.status_code} - {resp.text}")
                with open("llm_requests.log", "a") as f:
                    f.write(f"ERROR Response: {resp.status_code} - {resp.text}\n")
            resp.raise_for_status()
            return resp.json()

        allow_tools = True
        allow_structured = True

        def _build_schema():
            base_properties = {
                "asset": {"type": "string", "enum": assets},
                "action": {"type": "string", "enum": ["buy", "sell", "hold"]},
                "allocation_usd": {"type": "number", "minimum": 0},
                "tp_price": {"type": ["number", "null"]},
                "sl_price": {"type": ["number", "null"]},
                "exit_plan": {"type": "string"},
                "rationale": {"type": "string"},
            }
            required_keys = ["asset", "action", "allocation_usd", "tp_price", "sl_price", "exit_plan", "rationale"]
            if is_multi:
                return {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": base_properties,
                        "required": required_keys,
                        "additionalProperties": False,
                    },
                    "minItems": 1,
                }
            else:
                return {
                    "type": "object",
                    "properties": base_properties,
                    "required": required_keys,
                    "additionalProperties": False,
                }

        for _ in range(6):
            data = {"model": self.model, "messages": messages}
            if allow_structured:
                data["response_format"] = {
                    "type": "json_schema",
                    "json_schema": {
                        "name": "trade_decisions",
                        "strict": True,
                        "schema": _build_schema(),
                    },
                }
            if allow_tools:
                data["tools"] = tools
                data["tool_choice"] = "auto"
            try:
                resp_json = _post(data)
            except requests.HTTPError as e:
                try:
                    err = e.response.json()
                except Exception:
                    err = {}
                raw = (err.get("error", {}).get("metadata", {}) or {}).get("raw", "")
                provider = (err.get("error", {}).get("metadata", {}) or {}).get("provider_name", "")
                if e.response.status_code == 422 and provider.lower().startswith("xai") and "deserialize" in raw.lower():
                    logging.warning("xAI rejected tool schema; retrying without tools.")
                    if allow_tools:
                        allow_tools = False
                        continue
                # Provider may not support structured outputs / response_format
                err_text = json.dumps(err)
                if allow_structured and ("response_format" in err_text or "structured" in err_text or e.response.status_code in (400, 422)):
                    logging.warning("Provider rejected structured outputs; retrying without response_format.")
                    allow_structured = False
                    continue
                raise

            choice = resp_json["choices"][0]
            message = choice["message"]
            messages.append(message)

            tool_calls = message.get("tool_calls") or []
            if allow_tools and tool_calls:
                for tc in tool_calls:
                    if tc.get("type") == "function" and tc.get("function", {}).get("name") == "fetch_taapi_indicator":
                        args = json.loads(tc["function"].get("arguments") or "{}")
                        try:
                            params = {
                                "secret": self.taapi.api_key,
                                "exchange": "binance",
                                "symbol": args["symbol"],
                                "interval": args["interval"],
                            }
                            if args.get("period") is not None:
                                params["period"] = args["period"]
                            if args.get("backtrack") is not None:
                                params["backtrack"] = args["backtrack"]
                            if isinstance(args.get("other_params"), dict):
                                params.update(args["other_params"])
                            ind_resp = requests.get(f"{self.taapi.base_url}{args['indicator']}", params=params).json()
                            messages.append({
                                "role": "tool",
                                "tool_call_id": tc.get("id"),
                                "name": "fetch_taapi_indicator",
                                "content": json.dumps(ind_resp),
                            })
                        except Exception as ex:
                            messages.append({
                                "role": "tool",
                                "tool_call_id": tc.get("id"),
                                "name": "fetch_taapi_indicator",
                                "content": f"Error: {str(ex)}",
                            })
                continue

            try:
                # Prefer parsed field from structured outputs if present
                if isinstance(message.get("parsed"), (dict, list)):
                    parsed = message.get("parsed")
                else:
                    content = message.get("content") or "{}"
                    parsed = json.loads(content)
                if is_multi:
                    if isinstance(parsed, list):
                        result = []
                        for item in parsed:
                            if isinstance(item, dict):
                                item.setdefault("allocation_usd", 0.0)
                                item.setdefault("tp_price", None)
                                item.setdefault("sl_price", None)
                                item.setdefault("exit_plan", "")
                                item.setdefault("rationale", "")
                                result.append(item)
                            elif isinstance(item, list) and len(item) >= 7:
                                # Handle array format: [asset, action, alloc, tp, sl, exit_plan, rationale]
                                result.append({
                                    "asset": item[0],
                                    "action": item[1],
                                    "allocation_usd": float(item[2]) if item[2] else 0.0,
                                    "tp_price": float(item[3]) if item[3] and item[3] != "null" else None,
                                    "sl_price": float(item[4]) if item[4] and item[4] != "null" else None,
                                    "exit_plan": item[5] if len(item) > 5 else "",
                                    "rationale": item[6] if len(item) > 6 else ""
                                })
                        return result
                    else:
                        logging.error(f"Expected array for multi-asset, got: {type(parsed)}")
                        return []
                else:
                    if isinstance(parsed, dict):
                        parsed.setdefault("allocation_usd", 0.0)
                        parsed.setdefault("tp_price", None)
                        parsed.setdefault("sl_price", None)
                        parsed.setdefault("exit_plan", "")
                        parsed.setdefault("rationale", "")
                        return [parsed]
                    else:
                        logging.error(f"Expected dict for single-asset, got: {type(parsed)}")
                        return []
            except Exception as e:
                logging.error(f"JSON parse error: {e}, content: {content[:200]}")
                if is_multi:
                    return [{
                        "asset": a,
                        "action": "hold",
                        "allocation_usd": 0.0,
                        "tp_price": None,
                        "sl_price": None,
                        "exit_plan": "",
                        "rationale": "Parse error"
                    } for a in assets]
                else:
                    return [{
                        "action": "hold",
                        "allocation_usd": 0.0,
                        "tp_price": None,
                        "sl_price": None,
                        "exit_plan": "",
                        "rationale": "Parse error"
                    }]

        if is_multi:
            return [{
                "asset": a,
                "action": "hold",
                "allocation_usd": 0.0,
                "tp_price": None,
                "sl_price": None,
                "exit_plan": "",
                "rationale": "tool loop cap"
            } for a in assets]
        else:
            return [{
                "action": "hold",
                "allocation_usd": 0.0,
                "tp_price": None,
                "sl_price": None,
                "exit_plan": "",
                "rationale": "tool loop cap"
            }]
