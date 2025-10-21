import sys
import argparse
import pathlib
sys.path.append(str(pathlib.Path(__file__).parent.parent))
from src.agent.decision_maker import TradingAgent
from src.indicators.taapi_client import TAAPIClient
from src.trading.hyperliquid_api import HyperliquidAPI
import time
import asyncio
import logging
from collections import deque
from datetime import datetime, timezone
import math  # For Sharpe
from dotenv import load_dotenv
import os
import json
from aiohttp import web
from src.utils.formatting import format_number as fmt, format_size as fmt_sz

load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")

def clear_terminal():
    os.system('cls' if os.name == 'nt' else 'clear')

def get_interval_seconds(interval_str):
    if interval_str.endswith('m'):
        return int(interval_str[:-1]) * 60
    elif interval_str.endswith('h'):
        return int(interval_str[:-1]) * 3600
    elif interval_str.endswith('d'):
        return int(interval_str[:-1]) * 86400
    else:
        raise ValueError(f"Unsupported interval: {interval_str}")

def main():
    clear_terminal()
    parser = argparse.ArgumentParser(description="LLM-based Trading Agent on Hyperliquid")
    parser.add_argument("--assets", type=str, nargs="+", required=False, help="Assets to trade, e.g., BTC ETH")
    parser.add_argument("--interval", type=str, required=False, help="Interval period, e.g., 1h")
    args = parser.parse_args()

    # Allow assets/interval via .env (CONFIG) if CLI not provided
    from src.config_loader import CONFIG
    assets_env = CONFIG.get("assets")
    interval_env = CONFIG.get("interval")
    if (not args.assets or len(args.assets) == 0) and assets_env:
        # Support space or comma separated
        if "," in assets_env:
            args.assets = [a.strip() for a in assets_env.split(",") if a.strip()]
        else:
            args.assets = [a.strip() for a in assets_env.split(" ") if a.strip()]
    if not args.interval and interval_env:
        args.interval = interval_env

    if not args.assets or not args.interval:
        parser.error("Please provide --assets and --interval, or set ASSETS and INTERVAL in .env")

    taapi = TAAPIClient()
    hyperliquid = HyperliquidAPI()
    agent = TradingAgent()


    start_time = datetime.now(timezone.utc)
    invocation_count = 0
    trade_log = []  # For Sharpe: list of returns
    active_trades = []  # {'asset','is_long','amount','entry_price','tp_oid','sl_oid','exit_plan'}
    recent_events = deque(maxlen=200)
    diary_path = "diary.jsonl"
    initial_account_value = None
    # Perp mid-price history sampled each loop (authoritative, avoids spot/perp basis mismatch)
    price_history = {}

    print(f"Starting trading agent for assets: {args.assets} at interval: {args.interval}")

    def add_event(msg: str):
        logging.info(msg)

    async def run_loop():
        nonlocal invocation_count, initial_account_value
        while True:
            invocation_count += 1
            minutes_since_start = (datetime.now(timezone.utc) - start_time).total_seconds() / 60

            # number formatting helpers imported from src.utils.formatting

            # Global account state
            state = await hyperliquid.get_user_state()
            sharpe = calculate_sharpe(trade_log)

            # Format account info like example
            account_value = state['balance'] + sum(p.get('pnl', 0) for p in state['positions'])
            if initial_account_value is None:
                initial_account_value = account_value
            total_return = ((account_value - initial_account_value) / initial_account_value * 100.0) if initial_account_value else 0.0
            account_info = f"Current Total Return (percent): {total_return:.2f}%\nAvailable Cash: {fmt(state['balance'], 2)}\nCurrent Account Value: {fmt(account_value, 2)}\nSharpe Ratio: {sharpe:.3f}\nCurrent live positions & performance:\n"
            for pos in state['positions']:
                coin = pos.get('coin')
                current_px = round(await hyperliquid.get_current_price(coin), 2) if coin else 0
                liq_px = fmt(pos.get('liquidationPx') or pos.get('liqPx', 0), 2)
                qty_disp = fmt_sz(pos.get('szi'))
                entry_disp = fmt(pos.get('entryPx'), 2)
                pnl_disp = fmt(pos.get('pnl', 0), 4)
                account_info += f"{{'symbol': '{coin}', 'quantity': {qty_disp}, 'entry_price': {entry_disp}, 'current_price': {current_px}, 'liquidation_price': {liq_px}, 'unrealized_pnl': {pnl_disp}, 'leverage': {pos.get('leverage', 1)}, ...}}\n"
            account_info += "\nActive Trades with Exit Plans:\n"
            for trade in active_trades:
                opened_at_str = trade.get('opened_at')
                minutes_open = 0.0
                if opened_at_str:
                    try:
                        minutes_open = (datetime.now() - datetime.fromisoformat(opened_at_str)).total_seconds() / 60
                    except Exception:
                        minutes_open = 0.0
                amt_disp = fmt_sz(trade['amount'])
                entry_trade_disp = fmt(trade['entry_price'], 2)
                account_info += (
                    f"Asset: {trade['asset']}, Long: {trade['is_long']}, Amount: {amt_disp}, "
                    f"Entry: {entry_trade_disp}, Opened: {opened_at_str}, MinutesOpen: {minutes_open:.1f}, "
                    f"TP OID: {trade['tp_oid']}, SL OID: {trade['sl_oid']}, Exit Plan: {trade['exit_plan']}\n"
                )
            
            # Include recent diary entries for context
            account_info += "\nRecent Trading History (last 10 decisions):\n"
            try:
                with open(diary_path, "r") as f:
                    lines = f.readlines()
                    for line in lines[-10:]:
                        entry = json.loads(line)
                        account_info += f"{entry.get('timestamp', '')} - {entry.get('asset', '')}: {entry.get('action', '')} - {entry.get('rationale', '')[:80]}\n"
            except Exception:
                pass

            # Include active open orders context (TP/SL or any resting orders)
            try:
                open_orders = await hyperliquid.get_open_orders()
                account_info += "\nActive Open Orders:\n"
                for o in open_orders[:50]:  # cap to 50 for prompt size
                    coin = o.get('coin')
                    oid = o.get('oid')
                    side = o.get('isBuy')
                    sz = fmt_sz(o.get('sz'))
                    raw_px = o.get('px')
                    px = fmt(raw_px, 2) if raw_px not in (None, "None") else None
                    trig_px = o.get('triggerPx')
                    order_type_obj = o.get('orderType')
                    if isinstance(order_type_obj, dict) and len(order_type_obj.keys()) > 0:
                        order_type = list(order_type_obj.keys())[0]
                    else:
                        order_type = str(order_type_obj)
                    if trig_px is not None and px is None:
                        account_info += f"oid:{oid} {coin} {'BUY' if side else 'SELL'} sz:{sz} triggerPx:{fmt(trig_px,2)} type:{order_type}\n"
                    else:
                        account_info += f"oid:{oid} {coin} {'BUY' if side else 'SELL'} sz:{sz} px:{px} type:{order_type}\n"
            except Exception:
                pass

            # Reconcile active_trades with authoritative exchange state (positions + open orders)
            try:
                assets_with_positions = set()
                for pos in state['positions']:
                    try:
                        if abs(float(pos.get('szi') or 0)) > 0:
                            assets_with_positions.add(pos.get('coin'))
                    except Exception:
                        continue
                assets_with_orders = set([o.get('coin') for o in (open_orders or []) if o.get('coin')])
                for tr in active_trades[:]:
                    asset = tr.get('asset')
                    if asset not in assets_with_positions and asset not in assets_with_orders:
                        add_event(f"Reconciling stale active trade for {asset} (no position, no orders)")
                        active_trades.remove(tr)
                        with open(diary_path, "a") as f:
                            f.write(json.dumps({
                                "timestamp": datetime.now(timezone.utc).isoformat(),
                                "asset": asset,
                                "action": "reconcile_close",
                                "reason": "no_position_no_orders",
                                "opened_at": tr.get('opened_at')
                            }) + "\n")
            except Exception:
                pass

            # Include recent fills to reflect executed TP/SL
            try:
                fills = await hyperliquid.get_recent_fills(limit=50)
                account_info += "\nRecent Fills (latest 20):\n"
                for f in fills[-20:]:
                    try:
                        coin = f.get('coin') or f.get('asset')
                        is_buy = f.get('isBuy')
                        sz = fmt_sz(f.get('sz') or f.get('size'))
                        px = fmt(f.get('px') or f.get('price'), 2)
                        t_raw = f.get('time') or f.get('timestamp')
                        try:
                            # convert ms or s to ISO
                            t_int = int(t_raw)
                            if t_int > 1e12:
                                t_iso = datetime.fromtimestamp(t_int / 1000, tz=timezone.utc).isoformat()
                            else:
                                t_iso = datetime.fromtimestamp(t_int, tz=timezone.utc).isoformat()
                        except Exception:
                            t_iso = str(t_raw)
                        account_info += f"{t_iso} {coin} {'BUY' if is_buy else 'SELL'} sz:{sz} px:{px}\n"
                    except Exception:
                        continue
            except Exception:
                pass

            # Check and close if exit conditions met
            for trade in active_trades[:]:
                if await check_exit_condition(trade, taapi, hyperliquid):
                    close_order = await hyperliquid.place_sell_order(trade['asset'], trade['amount']) if trade['is_long'] else await hyperliquid.place_buy_order(trade['asset'], trade['amount'])
                    add_event(f"Closed {trade['asset']} due to exit plan: {trade['exit_plan']}")
                    # Cancel all remaining orders for this asset (TP/SL and any orphans)
                    cancel_result = await hyperliquid.cancel_all_orders(trade['asset'])
                    add_event(f"Cancelled {cancel_result.get('cancelled_count', 0)} orders for {trade['asset']}")
                    active_trades.remove(trade)
                    # Log to diary
                    with open(diary_path, "a") as f:
                        f.write(json.dumps({
                            "timestamp": datetime.now().isoformat(),
                            "asset": trade['asset'],
                            "action": "close",
                            "reason": "exit_plan_triggered",
                            "exit_plan": trade['exit_plan'],
                            "opened_at": trade.get('opened_at')
                        }) + "\n")

            # Gather data for ALL assets first
            all_market_data = ""
            asset_prices = {}
            for asset in args.assets:
                try:
                    # Gather data like example
                    current_price = round(await hyperliquid.get_current_price(asset), 2)
                    # Update perp mid-price history (sampled per loop)
                    if asset not in price_history:
                        price_history[asset] = deque(maxlen=60)
                    price_history[asset].append({"t": datetime.now(timezone.utc).isoformat(), "mid": fmt(current_price, 2)})
                    oi = await hyperliquid.get_open_interest(asset)
                    funding = await hyperliquid.get_funding_rate(asset)

                    # Initial indicators (intraday) from TAAPI only; avoid spot/perp basis mismatch
                    indicators = taapi.get_indicators(asset, args.interval)
                    hist_prices = []

                    intraday_tf = "5m"
                    ema_series = taapi.fetch_series("ema", f"{asset}/USDT", intraday_tf, results=10, params={"period": 20}, value_key="value")
                    macd_series = taapi.fetch_series("macd", f"{asset}/USDT", intraday_tf, results=10, value_key="valueMACD")
                    rsi7_series = taapi.fetch_series("rsi", f"{asset}/USDT", intraday_tf, results=10, params={"period": 7}, value_key="value")
                    rsi14_series = taapi.fetch_series("rsi", f"{asset}/USDT", intraday_tf, results=10, params={"period": 14}, value_key="value")
                    cur_rsi7 = round(rsi7_series[-1], 2) if rsi7_series else "N/A"
                    cur_ema20 = round(ema_series[-1], 2) if ema_series else "N/A"
                    cur_macd = round(macd_series[-1], 2) if macd_series else "N/A"
                    ema_series_r = [fmt(v, 2) for v in ema_series] if ema_series else []
                    macd_series_r = [fmt(v, 2) for v in macd_series] if macd_series else []
                    rsi7_series_r = [fmt(v, 2) for v in rsi7_series] if rsi7_series else []
                    rsi14_series_r = [fmt(v, 2) for v in rsi14_series] if rsi14_series else []

                    # Long-term (4h)
                    lt_ema20 = taapi.fetch_value("ema", f"{asset}/USDT", "4h", params={"period": 20}, key="value")
                    lt_ema20 = round(lt_ema20, 2) if lt_ema20 is not None else "N/A"
                    lt_ema50 = taapi.fetch_value("ema", f"{asset}/USDT", "4h", params={"period": 50}, key="value")
                    lt_ema50 = round(lt_ema50, 2) if lt_ema50 is not None else "N/A"
                    lt_atr3 = taapi.fetch_value("atr", f"{asset}/USDT", "4h", params={"period": 3}, key="value")
                    lt_atr3 = round(lt_atr3, 2) if lt_atr3 is not None else "N/A"
                    lt_atr14 = taapi.fetch_value("atr", f"{asset}/USDT", "4h", params={"period": 14}, key="value")
                    lt_atr14 = round(lt_atr14, 2) if lt_atr14 is not None else "N/A"
                    lt_macd_series = taapi.fetch_series("macd", f"{asset}/USDT", "4h", results=10, value_key="valueMACD")
                    lt_rsi_series = taapi.fetch_series("rsi", f"{asset}/USDT", "4h", results=10, params={"period": 14}, value_key="value")
                    lt_macd_series_r = [fmt(v, 2) for v in lt_macd_series] if lt_macd_series else []
                    lt_rsi_series_r = [fmt(v, 2) for v in lt_rsi_series] if lt_rsi_series else []

                    # Format like example
                    # Compute annualized funding (paid hourly: × 24 × 365)
                    funding_annualized = round(funding * 24 * 365 * 100, 2) if funding else None
                    market_data = f"ALL {asset.upper()} DATA\ncurrent_price = {current_price}, current_ema20 = {cur_ema20}, current_macd = {cur_macd}, current_rsi (7 period) = {cur_rsi7}\n"
                    market_data += f"Open Interest: {oi}\nFunding Rate: {funding} (Annualized: {funding_annualized}%)\n"
                    # Perp mid prices sampled per interval (authoritative, concise)
                    recent_mids = [p["mid"] for p in list(price_history.get(asset, []))[-10:]]
                    market_data += f"Perp mid prices (sampled): {json.dumps(recent_mids)}\n"
                    market_data += f"EMA indicators (20-period): {json.dumps(ema_series_r)}\n"
                    market_data += f"MACD indicators: {json.dumps(macd_series_r)}\n"
                    market_data += f"RSI indicators (7-Period): {json.dumps(rsi7_series_r)}\n"
                    market_data += f"RSI indicators (14-Period): {json.dumps(rsi14_series_r)}\n"
                    market_data += f"Longer-term context (4-hour timeframe):\n20-Period EMA: {lt_ema20} vs. 50-Period EMA: {lt_ema50}\n3-Period ATR: {lt_atr3} vs. {lt_atr14}\nMACD indicators: {json.dumps(lt_macd_series_r)}\nRSI indicators (14-Period): {json.dumps(lt_rsi_series_r)}\n\n"

                    all_market_data += market_data
                    asset_prices[asset] = current_price
                except Exception as e:
                    import traceback
                    add_event(f"Data gather error {asset}: {e}")
                    continue

            # Single LLM call with all assets
            context = (
                f"## Invocation\n"
                f"It has been {minutes_since_start:.0f} minutes since you started trading. "
                f"The current time is {datetime.now(timezone.utc).isoformat()} and you've been invoked {invocation_count} times.\n\n"
                f"## Market Data\n{all_market_data}\n"
                f"## Account Information & Performance\n{account_info}\n"
                f"## Instructions\nDecide actions for ALL assets: {', '.join(args.assets)}. Output a STRICT JSON array only.\n"
            )
            add_event(f"Combined prompt length: {len(context)} chars for {len(args.assets)} assets")
            with open("prompts.log", "a") as f:
                f.write(f"\n\n--- {datetime.now()} - ALL ASSETS ---\n{context}\n")

            def _is_failed_outputs(outs):
                if not outs:
                    return True
                try:
                    return all(isinstance(o, dict) and (o.get('action') == 'hold') and ('parse error' in (o.get('rationale','').lower())) for o in outs)
                except Exception:
                    return True

            try:
                outputs = agent.decide_trade(args.assets, context)
                if not isinstance(outputs, list):
                    add_event(f"Invalid output format (expected list): {outputs}")
                    outputs = []
            except Exception as e:
                import traceback
                add_event(f"Agent error: {e}")
                add_event(f"Traceback: {traceback.format_exc()}")
                outputs = []

            # Retry once on failure/parse error with a stricter instruction prefix
            if _is_failed_outputs(outputs):
                add_event("Retrying LLM once due to invalid/parse-error output")
                context_retry = (
                    "## Retry Instruction\nReturn ONLY the JSON array per schema with no prose.\n\n" + context
                )
                try:
                    outputs = agent.decide_trade(args.assets, context_retry)
                    if not isinstance(outputs, list):
                        add_event(f"Retry invalid format: {outputs}")
                        outputs = []
                except Exception as e:
                    import traceback
                    add_event(f"Retry agent error: {e}")
                    add_event(f"Retry traceback: {traceback.format_exc()}")
                    outputs = []

            # Execute trades for each asset
            for output in outputs:
                try:
                    asset = output.get("asset")
                    if not asset or asset not in args.assets:
                        continue
                    action = output.get("action")
                    current_price = asset_prices.get(asset, 0)
                    action = output["action"]
                    if action in ("buy", "sell"):
                        is_buy = action == "buy"
                        alloc_usd = float(output.get("allocation_usd", 0.0))
                        if alloc_usd <= 0:
                            add_event(f"Holding {asset}: zero/negative allocation")
                            continue
                        amount = alloc_usd / current_price

                        order = await hyperliquid.place_buy_order(asset, amount) if is_buy else await hyperliquid.place_sell_order(asset, amount)
                        # Confirm by checking recent fills for this asset shortly after placing
                        await asyncio.sleep(1)
                        fills_check = await hyperliquid.get_recent_fills(limit=10)
                        filled = False
                        for fc in reversed(fills_check):
                            try:
                                if (fc.get('coin') == asset or fc.get('asset') == asset):
                                    filled = True
                                    break
                            except Exception:
                                continue
                        trade_log.append({"type": action, "price": current_price, "amount": amount, "exit_plan": output["exit_plan"], "filled": filled})
                        tp_oid = None
                        sl_oid = None
                        if output["tp_price"]:
                            tp_order = await hyperliquid.place_take_profit(asset, is_buy, amount, output["tp_price"])
                            tp_oids = hyperliquid.extract_oids(tp_order)
                            tp_oid = tp_oids[0] if tp_oids else None
                            add_event(f"TP placed {asset} at {output['tp_price']}")
                        if output["sl_price"]:
                            sl_order = await hyperliquid.place_stop_loss(asset, is_buy, amount, output["sl_price"])
                            sl_oids = hyperliquid.extract_oids(sl_order)
                            sl_oid = sl_oids[0] if sl_oids else None
                            add_event(f"SL placed {asset} at {output['sl_price']}")
                        # Reconcile: if opposite-side position exists or TP/SL just filled, clear stale active_trades for this asset
                        for existing in active_trades[:]:
                            if existing.get('asset') == asset:
                                try:
                                    active_trades.remove(existing)
                                except ValueError:
                                    pass
                        active_trades.append({
                            "asset": asset,
                            "is_long": is_buy,
                            "amount": amount,
                            "entry_price": current_price,
                            "tp_oid": tp_oid,
                            "sl_oid": sl_oid,
                            "exit_plan": output["exit_plan"],
                            "opened_at": datetime.now().isoformat()
                        })
                        add_event(f"{action.upper()} {asset} amount {amount:.4f} at ~{current_price}")
                        # Write to diary after confirming fills status
                        with open(diary_path, "a") as f:
                            diary_entry = {
                                "timestamp": datetime.now(timezone.utc).isoformat(),
                                "asset": asset,
                                "action": action,
                                "allocation_usd": alloc_usd,
                                "amount": amount,
                                "entry_price": current_price,
                                "tp_price": output.get("tp_price"),
                                "tp_oid": tp_oid,
                                "sl_price": output.get("sl_price"),
                                "sl_oid": sl_oid,
                                "exit_plan": output.get("exit_plan", ""),
                                "rationale": output.get("rationale", ""),
                                "order_result": str(order),
                                "opened_at": datetime.now(timezone.utc).isoformat(),
                                "filled": filled
                            }
                            f.write(json.dumps(diary_entry) + "\n")
                    else:
                        add_event(f"Hold {asset}: {output.get('rationale', '')}")
                        # Write hold to diary
                        with open(diary_path, "a") as f:
                            diary_entry = {
                                "timestamp": datetime.now().isoformat(),
                                "asset": asset,
                                "action": "hold",
                                "rationale": output.get("rationale", "")
                            }
                            f.write(json.dumps(diary_entry) + "\n")
                except Exception as e:
                    import traceback
                    add_event(f"Execution error {asset}: {e}")

            await asyncio.sleep(get_interval_seconds(args.interval))

    async def handle_diary(request):
        try:
            raw = request.query.get('raw')
            download = request.query.get('download')
            if raw or download:
                if not os.path.exists(diary_path):
                    return web.Response(text="", content_type="text/plain")
                with open(diary_path, "r") as f:
                    data = f.read()
                headers = {}
                if download:
                    headers["Content-Disposition"] = f"attachment; filename=diary.jsonl"
                return web.Response(text=data, content_type="text/plain", headers=headers)
            limit = int(request.query.get('limit', '200'))
            with open(diary_path, "r") as f:
                lines = f.readlines()
            start = max(0, len(lines) - limit)
            entries = [json.loads(l) for l in lines[start:]]
            return web.json_response({"entries": entries})
        except FileNotFoundError:
            return web.json_response({"entries": []})
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)

    async def handle_logs(request):
        try:
            path = request.query.get('path', 'llm_requests.log')
            download = request.query.get('download')
            limit_param = request.query.get('limit')
            if not os.path.exists(path):
                return web.Response(text="", content_type="text/plain")
            with open(path, "r") as f:
                data = f.read()
            if download or (limit_param and (limit_param.lower() == 'all' or limit_param == '-1')):
                headers = {}
                if download:
                    headers["Content-Disposition"] = f"attachment; filename={os.path.basename(path)}"
                return web.Response(text=data, content_type="text/plain", headers=headers)
            limit = int(limit_param) if limit_param else 2000
            return web.Response(text=data[-limit:], content_type="text/plain")
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)

    async def start_api(app):
        app.router.add_get('/diary', handle_diary)
        app.router.add_get('/logs', handle_logs)

    async def main_async():
        app = web.Application()
        await start_api(app)
        from src.config_loader import CONFIG as CFG
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, CFG.get("api_host"), int(CFG.get("api_port")))
        await site.start()
        await run_loop()

    def calculate_total_return(state, trade_log):
        initial = 10000
        current = state['balance'] + sum(p.get('pnl', 0) for p in state.get('positions', []))
        return ((current - initial) / initial) * 100 if initial else 0

    def calculate_sharpe(returns):
        if not returns:
            return 0
        vals = [r.get('pnl', 0) if 'pnl' in r else 0 for r in returns]
        if not vals:
            return 0
        mean = sum(vals) / len(vals)
        var = sum((v - mean) ** 2 for v in vals) / len(vals)
        std = math.sqrt(var) if var > 0 else 0
        return mean / std if std > 0 else 0

    async def check_exit_condition(trade, taapi, hyperliquid):
        plan = (trade.get("exit_plan") or "").lower()
        if not plan:
            return False
        try:
            if "macd" in plan and "below" in plan:
                macd = taapi.get_indicators(trade["asset"], "4h")["macd"]["valueMACD"]
                threshold = float(plan.split("below")[-1].strip())
                return macd < threshold
            if "close above ema50" in plan:
                ema50 = taapi.get_historical_indicator("ema", f"{trade['asset']}/USDT", "4h", results=1, params={"period": 50})[0]["value"]
                current = await hyperliquid.get_current_price(trade["asset"])
                return current > ema50
        except Exception:
            return False
        return False

    asyncio.run(main_async())


if __name__ == "__main__":
    main()
