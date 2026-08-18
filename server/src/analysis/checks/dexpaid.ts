/**
 * Has the team PAID dexscreener (token profile / boosts / community takeover)?
 * Paying for a profile is a small but real "team spends money on the token"
 * signal. Public endpoint, no key.
 */
export async function fetchDexPaid(mint: string): Promise<boolean | null> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(`https://api.dexscreener.com/orders/v1/solana/${mint}`, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    clearTimeout(t);
    if (res.status === 404) return false;
    if (!res.ok) return null;
    const orders = (await res.json()) as any[];
    if (!Array.isArray(orders)) return false;
    return orders.some((o) => o?.status === "approved");
  } catch {
    return null;
  }
}
