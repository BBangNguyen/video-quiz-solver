// Ước tính chi phí từ `usage` Claude trả về.
import { PRICE_PER_MTOK } from './constants.js';

/** @param {{model: string, input_tokens?: number, output_tokens?: number, cache_read_input_tokens?: number, cache_creation_input_tokens?: number}} usage */
export function costOfUsage(usage) {
  const price = PRICE_PER_MTOK[usage?.model];
  if (!price) return 0;
  return (
    ((usage.input_tokens ?? 0) * price.input +
      (usage.output_tokens ?? 0) * price.output +
      (usage.cache_read_input_tokens ?? 0) * price.cacheRead +
      (usage.cache_creation_input_tokens ?? 0) * price.cacheWrite) /
    1_000_000
  );
}

export function totalCost(usages) {
  return usages.filter(Boolean).reduce((sum, u) => sum + costOfUsage(u), 0);
}

export function formatUsd(amount) {
  return `$${amount.toFixed(amount < 0.1 ? 3 : 2)}`;
}
