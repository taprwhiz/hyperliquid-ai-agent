export function formatNumber(value: unknown, decimals = 2): number | unknown {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return Number(numeric.toFixed(decimals));
  }
  return value;
}

export function formatSize(value: unknown): number | unknown {
  return formatNumber(value, 6);
}
