import asyncio
import logging
import aiohttp
from src.config_loader import CONFIG
from hyperliquid.exchange import Exchange
from hyperliquid.info import Info
from hyperliquid.utils import constants  # For MAINNET/TESTNET
from eth_account import Account
import logging

class HyperliquidAPI:
    def __init__(self):
        if "hyperliquid_private_key" in CONFIG and CONFIG["hyperliquid_private_key"]:
            self.wallet = Account.from_key(CONFIG["hyperliquid_private_key"])
        elif "mnemonic" in CONFIG and CONFIG["mnemonic"]:
            self.wallet = Account.from_mnemonic(CONFIG["mnemonic"])
        else:
            raise ValueError("Either HYPERLIQUID_PRIVATE_KEY/LIGHTER_PRIVATE_KEY or MNEMONIC must be provided")
        # Choose base URL: allow override via env-config; default MAINNET
        base_url = CONFIG.get("hyperliquid_base_url") or constants.MAINNET_API_URL
        self.info = Info(base_url)
        self.exchange = Exchange(self.wallet, base_url)

    def round_size(self, asset, amount):
        """Round amount to asset's szDecimals precision to avoid float_to_wire errors."""
        meta = self._meta_cache[0] if hasattr(self, '_meta_cache') and self._meta_cache else None
        if meta:
            universe = meta.get("universe", [])
            asset_info = next((u for u in universe if u.get("name") == asset), None)
            if asset_info:
                decimals = asset_info.get("szDecimals", 8)
                return round(amount, decimals)
        return round(amount, 8)

    async def place_buy_order(self, asset, amount, slippage=0.01):
        amount = self.round_size(asset, amount)
        return await asyncio.to_thread(self.exchange.market_open, asset, True, amount, None, slippage)

    async def place_sell_order(self, asset, amount, slippage=0.01):
        amount = self.round_size(asset, amount)
        return await asyncio.to_thread(self.exchange.market_open, asset, False, amount, None, slippage)

    async def place_take_profit(self, asset, is_buy, amount, tp_price):
        # TP as trigger order (market close at tp_price, reduce-only)
        amount = self.round_size(asset, amount)
        order_type = {"trigger": {"triggerPx": tp_price, "isMarket": True, "tpsl": "tp"}}
        return await asyncio.to_thread(self.exchange.order, asset, not is_buy, amount, tp_price, order_type, True)

    async def place_stop_loss(self, asset, is_buy, amount, sl_price):
        # SL as trigger order (market close at sl_price, reduce-only)
        amount = self.round_size(asset, amount)
        order_type = {"trigger": {"triggerPx": sl_price, "isMarket": True, "tpsl": "sl"}}
        return await asyncio.to_thread(self.exchange.order, asset, not is_buy, amount, sl_price, order_type, True)

    async def cancel_order(self, asset, oid):
        return await asyncio.to_thread(self.exchange.cancel, asset, oid)

    async def cancel_all_orders(self, asset):
        """Cancel all open orders for an asset."""
        try:
            open_orders = await asyncio.to_thread(self.info.frontend_open_orders, self.wallet.address)
            for order in open_orders:
                if order.get("coin") == asset:
                    oid = order.get("oid")
                    if oid:
                        await self.cancel_order(asset, oid)
            return {"status": "ok", "cancelled_count": len([o for o in open_orders if o.get("coin") == asset])}
        except Exception as e:
            logging.error(f"Cancel all orders error for {asset}: {e}")
            return {"status": "error", "message": str(e)}

    async def get_open_orders(self):
        """Return list of current open orders for this wallet."""
        try:
            return await asyncio.to_thread(self.info.frontend_open_orders, self.wallet.address)
        except Exception as e:
            logging.error(f"Get open orders error: {e}")
            return []

    def extract_oids(self, order_result):
        oids = []
        try:
            statuses = order_result["response"]["data"]["statuses"]
            for st in statuses:
                if "resting" in st and "oid" in st["resting"]:
                    oids.append(st["resting"]["oid"])
                if "filled" in st and "oid" in st["filled"]:
                    oids.append(st["filled"]["oid"])
        except Exception:
            pass
        return oids

    async def get_user_state(self):
        state = await asyncio.to_thread(self.info.user_state, self.wallet.address)
        positions = state.get("assetPositions", [])
        for pos_wrap in positions:
            pos = pos_wrap["position"]
            entry_px = float(pos.get("entryPx", 0) or 0)
            size = float(pos.get("szi", 0) or 0)
            side = "long" if size > 0 else "short"
            current_px = await self.get_current_price(pos["coin"]) if entry_px and size else 0.0
            pnl = (current_px - entry_px) * abs(size) if side == "long" else (entry_px - current_px) * abs(size)
            pos["pnl"] = pnl
        balance = float(state.get("withdrawable", 0.0))
        return {"balance": balance, "positions": [p["position"] for p in positions]}

    async def get_current_price(self, asset):
        mids = await asyncio.to_thread(self.info.all_mids)
        return float(mids.get(asset, 0.0))

    async def get_meta_and_ctxs(self):
        """Cache meta and asset contexts to avoid repeated calls."""
        if not hasattr(self, '_meta_cache') or not self._meta_cache:
            response = await asyncio.to_thread(self.info.meta_and_asset_ctxs)
            self._meta_cache = response
        return self._meta_cache

    async def get_open_interest(self, asset):
        try:
            data = await self.get_meta_and_ctxs()
            if isinstance(data, list) and len(data) >= 2:
                meta, asset_ctxs = data[0], data[1]
                universe = meta.get("universe", [])
                asset_idx = next((i for i, u in enumerate(universe) if u.get("name") == asset), None)
                if asset_idx is not None and asset_idx < len(asset_ctxs):
                    oi = asset_ctxs[asset_idx].get("openInterest")
                    return round(float(oi), 2) if oi else None
            return None
        except Exception as e:
            logging.error(f"OI fetch error for {asset}: {e}")
            return None

    async def get_funding_rate(self, asset):
        try:
            data = await self.get_meta_and_ctxs()
            if isinstance(data, list) and len(data) >= 2:
                meta, asset_ctxs = data[0], data[1]
                universe = meta.get("universe", [])
                asset_idx = next((i for i, u in enumerate(universe) if u.get("name") == asset), None)
                if asset_idx is not None and asset_idx < len(asset_ctxs):
                    funding = asset_ctxs[asset_idx].get("funding")
                    return round(float(funding), 8) if funding else None
            return None
        except Exception as e:
            logging.error(f"Funding fetch error for {asset}: {e}")
            return None
