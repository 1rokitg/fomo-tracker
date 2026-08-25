import roster from "../../config.json";

export function clanEvmWallets(): `0x${string}`[] {
  const seen = new Set<string>();
  const out: `0x${string}`[] = [];
  for (const entry of roster.handles || []) {
    if (typeof entry === "string") continue;
    const raw = String(entry?.evmAddress || entry?.evm || "").trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) continue;
    const addr = raw.toLowerCase() as `0x${string}`;
    if (seen.has(addr)) continue;
    seen.add(addr);
    out.push(addr);
  }
  return out;
}
