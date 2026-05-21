export function safeFloat(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function roundOrNone(value: unknown, decimals = 2): number | null {
  const numeric = safeFloat(value);
  if (numeric === null) return null;
  return Number(numeric.toFixed(decimals));
}

export function roundSeries(series: unknown[] | null | undefined, decimals = 2): Array<number | null> {
  if (!series?.length) return [];
  return series.map((val) => {
    const numeric = safeFloat(val);
    return numeric === null ? null : Number(numeric.toFixed(decimals));
  });
}

export function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Set) return [...value];
  return value;
}
