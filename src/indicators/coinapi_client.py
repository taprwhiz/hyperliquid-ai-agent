import requests
import time
import logging
from src.config_loader import CONFIG

class CoinAPIClient:
    def __init__(self):
        self.base_url = "https://rest.coinapi.io/v1"
        self.api_key = CONFIG.get("coinapi_key")
        self.headers = {"X-CoinAPI-Key": self.api_key} if self.api_key else {}

    def _get_with_retry(self, url, params, retries=3, backoff=1.0):
        """GET with exponential backoff retry."""
        for attempt in range(retries):
            try:
                resp = requests.get(url, headers=self.headers, params=params, timeout=10)
                resp.raise_for_status()
                return resp.json()
            except requests.HTTPError as e:
                if e.response.status_code >= 500 and attempt < retries - 1:
                    wait = backoff * (2 ** attempt)
                    logging.warning(f"CoinAPI {e.response.status_code}, retrying in {wait}s (attempt {attempt+1}/{retries})")
                    time.sleep(wait)
                else:
                    raise
            except requests.Timeout as e:
                if attempt < retries - 1:
                    wait = backoff * (2 ** attempt)
                    logging.warning(f"CoinAPI timeout, retrying in {wait}s")
                    time.sleep(wait)
                else:
                    raise
        raise RuntimeError("Max retries exceeded")

    def ohlcv_latest(self, symbol_id, period_id="5MIN", limit=10):
        """Fetch latest OHLCV data. Valid period_ids: 1MIN, 5MIN, 15MIN, 1HRS, 1DAY, etc."""
        if not self.api_key:
            raise ValueError("COINAPI_KEY not set in config")
        url = f"{self.base_url}/ohlcv/{symbol_id}/latest"
        params = {"period_id": period_id, "limit": limit}
        return self._get_with_retry(url, params)

    def orderbook_history(self, symbol_id, time_start, time_end=None, limit=100):
        url = f"{self.base_url}/orderbooks/history"
        params = {"symbol_id": symbol_id, "time_start": time_start, "limit": limit}
        if time_end:
            params["time_end"] = time_end
        resp = requests.get(url, headers=self.headers, params=params)
        resp.raise_for_status()
        return resp.json()
