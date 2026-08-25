import config from "./config.json";

export const FOMOSCAN_BASE = "https://api.fomoscan.sh/v2";
export const HELIUS_HISTORY_BASE = "https://mainnet.helius-rpc.com/v0";
export const HELIUS_API_BASE = "https://api.helius.xyz/v0";
export const CLAN_DIGEST_CRON = "0 */6 * * *";

const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const USD1 = "USD1ttGY1N17NEEHlmELoaybftRBUSerhqYiQzvEmuB";
const PYUSD = "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo";
const QUOTE_MINTS = new Set([WSOL, USDC, USDT, USD1, PYUSD]);

export function fomoscanHeaders(env) {
  return { Authorization: `Bearer ${env.FOMOSCAN_KEY}` };
}

export function normalizeHandle(handle) {
  return String(handle || "")
    .trim()
    .replace(/^@/, "")
    .toLowerCase();
}

export function configMembers(handles = config.handles) {
  return (handles || [])
    .map((entry) => {
      if (typeof entry === "string") {
        return {
          handle: normalizeHandle(entry),
          name: null,
          solanaAddress: null,
          evmAddress: null,
          fomoId: null,
          telegramHandle: null,
        };
      }
      return {
        handle: normalizeHandle(entry?.handle || entry?.username),
        name: entry?.name || entry?.displayName || null,
        solanaAddress: entry?.solanaAddress || entry?.solana || null,
        evmAddress: entry?.evmAddress || entry?.evm || null,
        fomoId: entry?.fomoId || entry?.id || null,
        telegramHandle:
          normalizeHandle(entry?.telegramHandle || entry?.telegram || entry?.tg) || null,
      };
    })
    .filter((m) => m.handle);
}

export function telegramHandleFor(fomoHandle, handles = config.handles) {
  const member = configMembers(handles).find((m) => m.handle === normalizeHandle(fomoHandle));
  return member?.telegramHandle || null;
}

export function swapVerb(side) {
  if (side === "SELL") return "SOLD";
  if (side === "BUY") return "BOUGHT";
  return null;
}

export function configHandleSet(handles = config.handles) {
  return new Set(configMembers(handles).map((m) => m.handle));
}

export function formatUsd(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "n/a";
  const abs = Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 0 });
  return `${v >= 0 ? "+" : "-"}$${abs}`;
}

export function short(addr) {
  if (!addr) return "unknown";
  return addr.length > 10 ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : addr;
}

export function pickClanFromBoard(board, clanId) {
  if (!clanId) return null;
  const entry = (board?.entries || []).find((e) => e.id === clanId);
  if (!entry) {
    return {
      id: clanId,
      found: false,
      window: board?.window || "24h",
      capturedAt: board?.capturedAt,
    };
  }
  return {
    found: true,
    window: board.window || "24h",
    capturedAt: board.capturedAt,
    id: entry.id,
    name: entry.label || entry.handle || "our clan",
    handle: entry.handle,
    rank: entry.rank,
    pnl: entry.pnl,
    volume: entry.volume,
    memberCount: entry.memberCount,
  };
}

export function clanHeadline(clan) {
  if (!clan?.found) return "Our clan · Rank";
  const bits = [clan.name];
  if (clan.rank != null) bits.push(`Rank #${clan.rank}`);
  if (clan.pnl != null) bits.push(`${formatUsd(clan.pnl)} PnL`);
  if (clan.memberCount != null) bits.push(`${clan.memberCount} members`);
  return bits.join(" · ");
}

function isQuoteMint(mint) {
  return Boolean(mint) && QUOTE_MINTS.has(mint);
}

function swapMints(tokens, native) {
  const mints = (tokens || []).map((t) => t.mint).filter(Boolean);
  if (native && (native.amount || native.amount === 0)) mints.push(WSOL);
  return mints;
}

function tokenAmount(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function uiTokenAmount(change) {
  const raw = tokenAmount(change?.rawTokenAmount?.tokenAmount ?? change?.tokenAmount);
  const decimals = Number(change?.rawTokenAmount?.decimals);
  if (Number.isFinite(decimals) && decimals > 0) return raw / 10 ** decimals;
  return raw;
}

function uniqueOwners(evt) {
  const set = new Set();
  if (evt?.feePayer) set.add(evt.feePayer);
  for (const t of evt?.tokenTransfers || []) {
    if (t.fromUserAccount) set.add(t.fromUserAccount);
    if (t.toUserAccount) set.add(t.toUserAccount);
  }
  for (const a of evt?.accountData || []) {
    for (const tb of a.tokenBalanceChanges || []) {
      if (tb.userAccount) set.add(tb.userAccount);
    }
  }
  return [...set];
}

function pushTokenMove(inputs, outputs, mint, amount) {
  if (!mint || !amount) return;
  if (amount < 0) inputs.push({ mint, tokenAmount: Math.abs(amount) });
  if (amount > 0) outputs.push({ mint, tokenAmount: amount });
}

function netTokenMoves(inputs, outputs) {
  const byMint = new Map();
  for (const t of inputs) {
    if (!t?.mint) continue;
    byMint.set(t.mint, (byMint.get(t.mint) || 0) - tokenAmount(t.tokenAmount));
  }
  for (const t of outputs) {
    if (!t?.mint) continue;
    byMint.set(t.mint, (byMint.get(t.mint) || 0) + tokenAmount(t.tokenAmount));
  }
  const tokenInputs = [];
  const tokenOutputs = [];
  for (const [mint, amt] of byMint) {
    if (!Number.isFinite(amt) || Math.abs(amt) < 1e-9) continue;
    if (amt < 0) tokenInputs.push({ mint, tokenAmount: Math.abs(amt) });
    else tokenOutputs.push({ mint, tokenAmount: amt });
  }
  return { tokenInputs, tokenOutputs };
}

function hasNonQuoteToken(inputs, outputs) {
  return [...(inputs || []), ...(outputs || [])].some((t) => t?.mint && !isQuoteMint(t.mint));
}

function movesFromTransfers(evt, owner) {
  const tokenInputs = [];
  const tokenOutputs = [];
  for (const t of evt.tokenTransfers || []) {
    const amt = tokenAmount(t.tokenAmount);
    if (!amt || !t.mint) continue;
    if (t.fromUserAccount === owner) tokenInputs.push({ mint: t.mint, tokenAmount: amt });
    if (t.toUserAccount === owner) tokenOutputs.push({ mint: t.mint, tokenAmount: amt });
  }
  return netTokenMoves(tokenInputs, tokenOutputs);
}

function movesFromBalances(evt, owner) {
  const tokenInputs = [];
  const tokenOutputs = [];
  let saw = false;
  for (const row of evt.accountData || []) {
    for (const tb of row.tokenBalanceChanges || []) {
      const holder = tb.userAccount || (row.account === owner ? owner : null);
      if (holder !== owner || !tb.mint) continue;
      saw = true;
      pushTokenMove(tokenInputs, tokenOutputs, tb.mint, uiTokenAmount(tb));
    }
  }
  if (!saw) return null;
  return netTokenMoves(tokenInputs, tokenOutputs);
}

/**
 * Build a SWAP events.swap object from enhanced token/native transfers.
 * Helius often types DFlow aggregator trades as UNKNOWN, not SWAP.
 * FOMO routes through USD1 — net hops so the meme token is the focus.
 */
export function synthesizeSwap(evt, owner = evt?.feePayer) {
  if (!owner) return null;

  const fromBal = movesFromBalances(evt, owner);
  const fromTx = movesFromTransfers(evt, owner);
  const picked =
    fromBal && hasNonQuoteToken(fromBal.tokenInputs, fromBal.tokenOutputs)
      ? fromBal
      : fromTx && hasNonQuoteToken(fromTx.tokenInputs, fromTx.tokenOutputs)
        ? fromTx
        : fromBal || fromTx || { tokenInputs: [], tokenOutputs: [] };
  const tokenInputs = picked.tokenInputs;
  const tokenOutputs = picked.tokenOutputs;

  let nativeIn = 0;
  let nativeOut = 0;

  for (const n of evt.nativeTransfers || []) {
    const amt = tokenAmount(n.amount);
    if (!amt) continue;
    if (n.fromUserAccount === owner) nativeIn += amt;
    if (n.toUserAccount === owner) nativeOut += amt;
  }

  if (!nativeIn && !nativeOut) {
    for (const row of evt.accountData || []) {
      if (row.account !== owner) continue;
      const native = tokenAmount(row.nativeBalanceChange);
      if (native < 0) nativeIn += Math.abs(native);
      if (native > 0) nativeOut += native;
    }
  }

  const nativeNet = nativeOut - nativeIn;
  const nativeInput = nativeNet < 0 ? { amount: Math.abs(nativeNet) } : null;
  const nativeOutput = nativeNet > 0 ? { amount: nativeNet } : null;

  const tokenMoves = tokenInputs.length + tokenOutputs.length;
  const sides = tokenMoves + (nativeInput ? 1 : 0) + (nativeOutput ? 1 : 0);
  if (!tokenMoves || sides < 2) return null;

  return {
    tokenInputs,
    tokenOutputs,
    nativeInput,
    nativeOutput,
  };
}

/** Treat Helius SWAP events and synthesized aggregator trades as swaps. */
export function asSwapEvent(evt) {
  if (!evt) return null;

  const wrap = (swap) => ({
    ...evt,
    type: "SWAP",
    events: { ...(evt.events || {}), swap },
  });
  const hasFocusMint = (e) => Boolean(e && swapFocus(e)?.token?.mint);

  if (hasFocusMint(evt)) return evt;

  const owners = uniqueOwners(evt);
  const ordered = evt.feePayer
    ? [evt.feePayer, ...owners.filter((o) => o !== evt.feePayer)]
    : owners;

  let fallback = null;
  for (const owner of ordered) {
    const swap = synthesizeSwap(evt, owner);
    if (!swap) continue;
    const next = wrap(swap);
    if (hasFocusMint(next)) return next;
    if (!fallback && (swapSide(next) || owner === evt.feePayer)) fallback = next;
  }
  if (fallback) return fallback;
  if (evt.type === "SWAP" || evt.events?.swap) return evt;
  return null;
}

/** BUY = spent SOL/stable for a token. SELL = sold a token for SOL/stable. */
export function swapSide(evt) {
  const swap = evt?.events?.swap;
  if (!swap) return null;

  const inMints = swapMints(swap.tokenInputs, swap.nativeInput);
  const outMints = swapMints(swap.tokenOutputs, swap.nativeOutput);
  const spentQuote = inMints.some(isQuoteMint);
  const receivedQuote = outMints.some(isQuoteMint);
  const spentToken = inMints.some((m) => !isQuoteMint(m));
  const receivedToken = outMints.some((m) => !isQuoteMint(m));

  if (spentQuote && receivedToken) return "BUY";
  if (spentToken && receivedQuote) return "SELL";
  return null;
}

const QUOTE_META = {
  [WSOL]: { symbol: "SOL", name: "Solana" },
  [USDC]: { symbol: "USDC", name: "USD Coin" },
  [USDT]: { symbol: "USDT", name: "Tether" },
  [USD1]: { symbol: "USD1", name: "USD1" },
  [PYUSD]: { symbol: "PYUSD", name: "PayPal USD" },
};

export function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function formatMoney(n) {
  if (n == null || n === "") return null;
  const v = Number(n);
  if (!Number.isFinite(v) || v === 0) return null;
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e4) return `${sign}$${Math.round(abs).toLocaleString("en-US")}`;
  return `${sign}$${abs.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 0 })}`;
}

function quoteSymbol(mint) {
  return QUOTE_META[mint]?.symbol || null;
}

function fmtQty(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v === 0) return null;
  if (v >= 1000) return v.toLocaleString("en-US", { maximumFractionDigits: 1 });
  if (v >= 1) return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return String(Number(v.toPrecision(3)));
}

function nativeToSol(amount) {
  const v = Number(amount);
  if (!Number.isFinite(v)) return 0;
  return v >= 1e6 ? v / 1e9 : v;
}

/** Quote vs meme token on a synthesized/enhanced swap. */
export function swapFocus(evt) {
  const swap = evt?.events?.swap;
  const side = swapSide(evt);
  if (!swap) return { side, token: null, quote: null };

  const tokensIn = [...(swap.tokenInputs || [])];
  const tokensOut = [...(swap.tokenOutputs || [])];
  if (swap.nativeInput?.amount) {
    tokensIn.push({ mint: WSOL, tokenAmount: nativeToSol(swap.nativeInput.amount) });
  }
  if (swap.nativeOutput?.amount) {
    tokensOut.push({ mint: WSOL, tokenAmount: nativeToSol(swap.nativeOutput.amount) });
  }

  const pickQuote = (arr) =>
    [...(arr || [])]
      .filter((t) => isQuoteMint(t.mint))
      .sort((a, b) => tokenAmount(b.tokenAmount) - tokenAmount(a.tokenAmount))[0];
  const pickToken = (arr) =>
    [...(arr || [])]
      .filter((t) => t.mint && !isQuoteMint(t.mint))
      .sort((a, b) => tokenAmount(b.tokenAmount) - tokenAmount(a.tokenAmount))[0];
  const quote = pickQuote(tokensIn) || pickQuote(tokensOut);
  const token =
    side === "BUY"
      ? pickToken(tokensOut)
      : side === "SELL"
        ? pickToken(tokensIn) || pickToken(tokensOut)
        : pickToken(tokensOut) || pickToken(tokensIn);
  return { side, token: token || null, quote: quote || null };
}

export function chainSlugs(network) {
  const n = String(network || "sol")
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  const table = {
    sol: { fomo: "solana", dex: "solana", gecko: "solana", bird: "solana" },
    solana: { fomo: "solana", dex: "solana", gecko: "solana", bird: "solana" },
    eth: { fomo: "ethereum", dex: "ethereum", gecko: "eth", bird: "ethereum" },
    ethereum: { fomo: "ethereum", dex: "ethereum", gecko: "eth", bird: "ethereum" },
    base: { fomo: "base", dex: "base", gecko: "base", bird: "base" },
    bnb: { fomo: "bsc", dex: "bsc", gecko: "bsc", bird: "bsc" },
    bsc: { fomo: "bsc", dex: "bsc", gecko: "bsc", bird: "bsc" },
    hood: { fomo: "hood", dex: "robinhood", gecko: null, bird: null },
    robinhood: { fomo: "hood", dex: "robinhood", gecko: null, bird: null },
    robinhoodchain: { fomo: "hood", dex: "robinhood", gecko: null, bird: null },
  };
  return table[n] || { fomo: n, dex: n, gecko: n, bird: null };
}

function emptyDexToken(mint) {
  return {
    mint,
    symbol: null,
    name: null,
    priceUsd: null,
    solPriceUsd: null,
    mcap: null,
    liquidity: null,
    pairCreatedAt: null,
    chainId: null,
    holders: null,
    pairUrl: null,
  };
}

export function formatAge(createdAtMs, now = Date.now()) {
  const t = Number(createdAtMs);
  if (!Number.isFinite(t) || t <= 0) return null;
  const sec = Math.max(0, (now - t) / 1000);
  if (sec < 60) return `${Math.max(1, Math.floor(sec))}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  if (sec < 86400 * 30) return `${Math.floor(sec / 86400)}d`;
  if (sec < 86400 * 365) return `${Math.floor(sec / (86400 * 30))}mo`;
  return `${Math.floor(sec / (86400 * 365))}y`;
}

export function chainLabel(network) {
  const n = String(network || "sol")
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  const table = {
    sol: "Solana",
    solana: "Solana",
    eth: "Ethereum",
    ethereum: "Ethereum",
    base: "Base",
    bnb: "BNB",
    bsc: "BNB",
    hood: "Robinhood",
    robinhood: "Robinhood",
    robinhoodchain: "Robinhood",
  };
  return table[n] || String(network || "Solana");
}

async function fetchHolderCount(mint, chain, fetchImpl) {
  const n = String(chain || "solana").toLowerCase();
  if (n !== "solana" && n !== "sol") return null;
  try {
    const res = await fetchImpl(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`);
    if (!res.ok) return null;
    const data = await res.json();
    const nHolders =
      data?.totalHolders ?? data?.token?.totalHolders ?? data?.holderCount ?? data?.holders;
    const v = Number(nHolders);
    return Number.isFinite(v) && v >= 0 ? v : null;
  } catch {
    return null;
  }
}

export async function fetchDexToken(mint, fetchImpl = fetch, network = "sol") {
  if (!mint) return null;
  if (isQuoteMint(mint)) {
    return {
      ...emptyDexToken(mint),
      ...QUOTE_META[mint],
      priceUsd: mint === WSOL ? null : 1,
    };
  }
  const want = chainSlugs(network).dex;
  try {
    const res = await fetchImpl(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
    if (!res.ok) return emptyDexToken(mint);
    const data = await res.json();
    const pairs = (data?.pairs || [])
      .filter((p) => !p.chainId || !want || p.chainId === want)
      .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    const pair = pairs[0];
    if (!pair) return emptyDexToken(mint);
    const base = pair.baseToken?.address === mint ? pair.baseToken : pair.quoteToken || pair.baseToken;
    const priceUsd = Number(pair.priceUsd) || null;
    const priceNative = Number(pair.priceNative) || null;
    const quoteAddr = pair.quoteToken?.address || "";
    const quoteIsSol = quoteAddr === WSOL || /^sol$/i.test(pair.quoteToken?.symbol || "");
    const solPriceUsd =
      quoteIsSol && priceUsd && priceNative && priceNative > 0 ? priceUsd / priceNative : null;
    const holders = await fetchHolderCount(mint, pair.chainId || want, fetchImpl);
    return {
      mint,
      symbol: base?.symbol || pair.baseToken?.symbol || null,
      name: base?.name || pair.baseToken?.name || null,
      priceUsd,
      solPriceUsd,
      mcap: pair.marketCap || pair.fdv || null,
      liquidity: Number(pair.liquidity?.usd) || null,
      pairCreatedAt: Number(pair.pairCreatedAt) || null,
      chainId: pair.chainId || want || null,
      holders,
      pairUrl: pair.url || null,
    };
  } catch (err) {
    console.error("dexscreener failed", err);
    return emptyDexToken(mint);
  }
}

function tradeUsd(focus, token) {
  const quote = focus?.quote;
  const qAmt = Number(quote?.tokenAmount);
  if (quote?.mint === WSOL && Number.isFinite(qAmt) && qAmt > 0) {
    const solPx = Number(token?.solPriceUsd);
    if (Number.isFinite(solPx) && solPx > 0) return qAmt * solPx;
  }
  if (quote && quote.mint !== WSOL) {
    const n = Number(quote.tokenAmount);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const qty = Number(focus?.token?.tokenAmount);
  const px = Number(token?.priceUsd);
  if (Number.isFinite(qty) && Number.isFinite(px) && qty > 0 && px > 0) return qty * px;
  return null;
}

function amountLine(focus, token) {
  const usdBit = formatMoney(tradeUsd(focus, token));
  const q = fmtQty(focus?.quote?.tokenAmount);
  const qSym = quoteSymbol(focus?.quote?.mint) || (focus?.quote?.mint === WSOL ? "SOL" : null);
  const qtyBit = q && qSym ? `${q} ${qSym}` : null;
  if (usdBit && qtyBit) return `💰 Amount: ${usdBit}  |  ${qtyBit}`;
  if (usdBit) return `💰 Amount: ${usdBit}`;
  const tSym = token?.symbol || "token";
  const t = fmtQty(focus?.token?.tokenAmount);
  if (focus?.side === "BUY" && qtyBit && t) return `💰 Amount: ${qtyBit} → ${t} ${tSym}`;
  if (focus?.side === "SELL" && qtyBit && t) return `💰 Amount: ${t} ${tSym} → ${qtyBit}`;
  if (t) return `💰 Amount: ${t} ${tSym}`;
  if (qtyBit) return `💰 Amount: ${qtyBit}`;
  return null;
}

function fomoRefUrl() {
  const raw = config.fomoRef || config.fomoRefLink || configMembers()[0]?.handle;
  if (!raw) return null;
  const value = String(raw);
  if (value.startsWith("http")) return value;
  return `https://fomo.family/r/${encodeURIComponent(normalizeHandle(value))}`;
}

function htmlLink(url, label) {
  return `<a href="${url}">${label}</a>`;
}

function linkRow({ sig, mint, network } = {}) {
  const slugs = chainSlugs(network);
  const bits = [];
  if (sig && slugs.fomo === "solana") {
    bits.push(htmlLink(`https://solscan.io/tx/${sig}`, "Scan"));
  }
  if (mint) {
    bits.push(htmlLink(`https://fomo.family/tokens/${slugs.fomo}/${mint}`, "Fomo"));
    if (slugs.dex) bits.push(htmlLink(`https://dexscreener.com/${slugs.dex}/${mint}`, "DexS"));
    if (slugs.gecko) {
      bits.push(htmlLink(`https://www.geckoterminal.com/${slugs.gecko}/tokens/${mint}`, "Gecko"));
    }
    if (slugs.bird) bits.push(htmlLink(`https://birdeye.so/token/${mint}?chain=${slugs.bird}`, "Bird"));
    bits.push(htmlLink(`https://x.com/search?q=${encodeURIComponent(mint)}`, "𝕏"));
  }
  const ref = fomoRefUrl();
  if (ref) bits.push(htmlLink(ref, "Ref"));
  return bits.length ? bits.join(" · ") : null;
}

function clanSubline(clan) {
  if (!clan?.found) return "Rank";
  const bits = [];
  if (clan.rank != null) bits.push(`Rank #${clan.rank}`);
  if (clan.pnl != null) bits.push(formatUsd(clan.pnl));
  if (clan.memberCount != null) bits.push(`${clan.memberCount} members`);
  return bits.join(" · ") || "Rank";
}

export function formatClanDigest({ clan, members = configMembers() } = {}) {
  const lines = [
    `📣 <b>${escapeHtml(clan?.found ? clan.name : "Clan")}</b>`,
    clanSubline(clan),
    "",
    "🎯 Member List",
  ];
  for (const m of members) {
    const mention = `@${escapeHtml(m.telegramHandle || m.handle)}`;
    const showName =
      m.name && String(m.name).trim() && normalizeHandle(m.name) !== m.handle;
    lines.push(showName ? `${escapeHtml(m.name)} · ${mention}` : mention);
  }
  return lines.join("\n");
}

export function formatClanAlert({ persona, evt, clan, isClanMember, token } = {}) {
  const focus = swapFocus(evt);
  const side = focus.side;
  const tg =
    normalizeHandle(persona?.telegramHandle) || telegramHandleFor(persona?.handle) || persona?.handle;
  const mention = `@${escapeHtml(tg)}`;
  const who = isClanMember ? mention : `${mention} (extra)`;
  const sig = evt?.signature;
  const mint = token?.mint || focus.token?.mint || null;
  const symbol = token?.symbol || (mint ? short(mint) : null);
  const name = token?.name && token.name !== token.symbol ? token.name : null;
  const isTest = /test ping/i.test(evt?.description || "");
  const wallet = persona?.solana_address || persona?.solanaAddress || null;
  const network = token?.chainId || "sol";

  const lines = [`📣 <b>${escapeHtml(clan?.found ? clan.name : "Clan")}</b>`, clanSubline(clan), ""];

  if (!isTest && (symbol || name)) {
    const circle = side === "SELL" ? "🔴" : "🟢";
    const title = name && symbol ? `${name} | ${symbol}` : name || symbol;
    lines.push(
      `${circle} ${escapeHtml(title)} 🧬 ${escapeHtml(chainLabel(network))}`,
    );
    if (mint) lines.push(escapeHtml(mint));
    lines.push("");
  }

  const memberBits = [`🎯 Member: ${who}`];
  if (!isTest && wallet) {
    memberBits.push(
      `(${htmlLink(`https://solscan.io/address/${wallet}`, escapeHtml(short(wallet)))})`,
    );
  }
  lines.push(memberBits.join(" "));
  if (isTest) {
    lines.push("🔭 Test ping");
  } else {
    if (side === "SELL") lines.push("📉 Action: SELL");
    else if (side === "BUY") lines.push("📈 Action: BUY");
    const amt = amountLine(focus, token);
    if (amt) lines.push(amt);
    if (token?.mcap) lines.push(`📊 Mcap: ${formatMoney(token.mcap)}`);
    if (token?.liquidity) lines.push(`💧 Liquidity: ${formatMoney(token.liquidity)}`);
    const age = formatAge(token?.pairCreatedAt);
    if (age) lines.push(`⏱ Age: ${age}`);
    if (Number(token?.holders) > 0) {
      lines.push(`👥 Holders: ${Number(token.holders).toLocaleString("en-US")}`);
    }
  }

  const links = linkRow({ sig, mint: isTest ? null : mint, network });
  if (links) {
    lines.push("", links);
  }
  return lines.join("\n");
}

export function thesisBody(item) {
  if (item?.thesis != null && String(item.thesis).trim()) return String(item.thesis).trim();
  if (Array.isArray(item?.segments)) {
    const joined = item.segments
      .map((s) => (typeof s === "string" ? s : s?.text || ""))
      .join("");
    if (joined.trim()) return joined.trim();
  }
  return "";
}

export function primedThesisKey(handle) {
  return `uprimed:${normalizeHandle(handle)}`;
}

export const CLAN_THESIS_FEED_KEY = primedThesisKey("clan-feed");

export function normalizePerson(value) {
  return String(value || "")
    .trim()
    .replace(/^@/, "")
    .toLowerCase()
    .replace(/\s+/g, "");
}

export function memberMatchKeys(member) {
  return new Set(
    [member?.handle, member?.name, member?.telegramHandle].map(normalizePerson).filter(Boolean),
  );
}

/** Match a thesis to a clan roster row by authorHandle or authorName. */
export function thesisClanMember(item, members = configMembers()) {
  const keys = [item?.authorHandle, item?.authorName].map(normalizePerson).filter(Boolean);
  if (!keys.length) return null;
  return (
    members.find((m) => {
      const aliases = memberMatchKeys(m);
      return keys.some((k) => aliases.has(k));
    }) || null
  );
}

/**
 * Walk newest-first items until a previously seen id. Returns the new
 * ones oldest-first so Telegram reads in chronological order.
 */
export function collectNewTheses(items, seenIds) {
  const fresh = [];
  for (const item of items || []) {
    if (!item?.id) continue;
    if (seenIds.has(item.id)) break;
    fresh.push(item);
  }
  return fresh.reverse();
}

export function formatThesisAlert({ persona, thesis, clan, isClanMember, token } = {}) {
  const tg =
    normalizeHandle(persona?.telegramHandle) || telegramHandleFor(persona?.handle) || persona?.handle;
  const mention = `@${escapeHtml(tg)}`;
  const who = isClanMember ? mention : `${mention} (extra)`;
  const mint = token?.mint || thesis?.tokenAddress || null;
  const network = thesis?.tokenNetwork || token?.network || "sol";
  const symbol = token?.symbol || thesis?.tokenSymbol || (mint ? short(mint) : null);
  const name = token?.name && token.name !== token.symbol ? token.name : null;
  const body = thesisBody(thesis);

  const lines = [`📣 <b>${escapeHtml(clan?.found ? clan.name : "Clan")}</b>`, clanSubline(clan), ""];

  if (symbol || name) {
    lines.push(escapeHtml(name ? `${symbol} | ${name}` : symbol));
    if (mint) lines.push(escapeHtml(mint));
    lines.push("");
  }

  lines.push(`🎯 ${who}`);
  lines.push("");

  if (body) {
    const clipped = body.length > 3500 ? `${body.slice(0, 3497)}…` : body;
    lines.push(`<blockquote>${escapeHtml(clipped)}</blockquote>`);
  } else {
    lines.push("📝 Thesis");
  }

  const meta = [];
  const trade = Number(thesis?.authorTradeUsd);
  if (Number.isFinite(trade) && trade > 0) meta.push(`💰 ${formatMoney(trade)}`);
  if (token?.mcap) meta.push(`📊 ${formatMoney(token.mcap)}`);
  else {
    const held = Number(thesis?.holdingsUsd);
    if (Number.isFinite(held) && held > 0) meta.push(`📊 ${formatMoney(held)}`);
  }
  if (meta.length) {
    lines.push("");
    lines.push(meta.join("   "));
  }

  const links = linkRow({ mint, network });
  if (links) {
    lines.push("", links);
  }
  return lines.join("\n");
}

export async function fetchThesisFeed(env, { before, fetchImpl = fetch } = {}) {
  const qs = before ? `?before=${encodeURIComponent(before)}` : "";
  const res = await fetchImpl(`${FOMOSCAN_BASE}/thesis${qs}`, {
    headers: fomoscanHeaders(env),
  });
  if (!res.ok) {
    console.error("thesis feed failed:", res.status, await res.text());
    return { items: [], hasMore: false, nextBefore: null };
  }
  return res.json();
}

export async function fetchUserTheses(env, userId, { before, fetchImpl = fetch } = {}) {
  const qs = before ? `?before=${encodeURIComponent(before)}` : "";
  const res = await fetchImpl(
    `${FOMOSCAN_BASE}/thesis/user/${encodeURIComponent(userId)}${qs}`,
    { headers: fomoscanHeaders(env) },
  );
  if (!res.ok) {
    console.error("user theses failed:", res.status, await res.text());
    return { items: [], hasMore: false, nextBefore: null };
  }
  return res.json();
}

export function pageNeedsOlderTheses(page, seenIds) {
  const items = page?.items || [];
  if (!page?.hasMore || !items.length) return false;
  const oldest = items[items.length - 1];
  return Boolean(oldest?.id && !seenIds.has(oldest.id));
}

export async function fetchLatestSwap(env, address, fetchImpl = fetch) {
  const url =
    `${HELIUS_HISTORY_BASE}/addresses/${address}/transactions` +
    `?api-key=${env.HELIUS_API_KEY}&type=SWAP&limit=1`;
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(`Helius history ${res.status} ${await res.text()}`);
  }
  const txs = await res.json();
  if (!Array.isArray(txs) || !txs.length) return null;
  return txs[0];
}

export async function fetchClanSnapshot(env, fetchImpl = fetch) {
  const clanId = config.clanId;
  if (!clanId) return null;

  const res = await fetchImpl(`${FOMOSCAN_BASE}/leaderboard/clans?window=24h`, {
    headers: fomoscanHeaders(env),
  });
  if (!res.ok) {
    console.error("Clan leaderboard failed:", res.status, await res.text());
    return { id: clanId, found: false, window: "24h" };
  }

  return pickClanFromBoard(await res.json(), clanId);
}

export function heliusEvents(payload) {
  if (payload == null) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.transactions)) return payload.transactions;
  if (Array.isArray(payload.result)) return payload.result;
  return [payload];
}

export function collectTouchedAccounts(evt) {
  const set = new Set();
  if (evt?.feePayer) set.add(evt.feePayer);
  if (evt?.signer) set.add(evt.signer);
  for (const s of evt?.signers || []) {
    if (typeof s === "string") set.add(s);
  }
  for (const a of evt?.accountData || []) {
    if (a?.account) set.add(a.account);
  }
  for (const key of evt?.transaction?.message?.accountKeys || []) {
    if (typeof key === "string") set.add(key);
    else if (key?.pubkey) set.add(key.pubkey);
  }
  for (const t of evt?.tokenTransfers || []) {
    if (t?.fromUserAccount) set.add(t.fromUserAccount);
    if (t?.toUserAccount) set.add(t.toUserAccount);
  }
  return [...set];
}

export function txSignature(evt) {
  return evt?.signature || evt?.transaction?.signatures?.[0] || null;
}

function rpcPubkey(key) {
  if (!key) return null;
  if (typeof key === "string") return key;
  return key.pubkey || null;
}

function rpcAccountKeys(result) {
  const msg = result?.transaction?.message || {};
  const keys = (msg.accountKeys || []).map(rpcPubkey).filter(Boolean);
  const loaded = result?.meta?.loadedAddresses || {};
  for (const k of loaded.writable || []) keys.push(rpcPubkey(k) || k);
  for (const k of loaded.readonly || []) keys.push(rpcPubkey(k) || k);
  return keys;
}

function tokenOwner(b, accountKeys) {
  return b?.owner || accountKeys[b?.accountIndex] || null;
}

function rpcUiAmount(balance) {
  const ui = balance?.uiTokenAmount;
  if (!ui) return 0;
  if (ui.uiAmount != null && Number.isFinite(Number(ui.uiAmount))) return Number(ui.uiAmount);
  if (ui.uiAmountString) return tokenAmount(ui.uiAmountString);
  const decimals = Number(ui.decimals || 0);
  const raw = tokenAmount(ui.amount);
  return decimals ? raw / 10 ** decimals : raw;
}

/**
 * Rebuild an enhanced-shaped event from RPC getTransaction (jsonParsed).
 * Used when Helius enhanced parse returns [] for aggregator trades.
 */
export function rpcToEnhanced(result, sig) {
  if (!result?.meta || result.meta.err) return null;

  const accountKeys = rpcAccountKeys(result);
  const feePayer = accountKeys[0] || null;
  const tokenTransfers = [];
  const owners = new Set();

  for (const b of [...(result.meta.preTokenBalances || []), ...(result.meta.postTokenBalances || [])]) {
    const owner = tokenOwner(b, accountKeys);
    if (owner) owners.add(owner);
  }

  for (const owner of owners) {
    const preMap = new Map();
    const postMap = new Map();
    for (const b of result.meta.preTokenBalances || []) {
      if (tokenOwner(b, accountKeys) !== owner || !b.mint) continue;
      preMap.set(b.mint, (preMap.get(b.mint) || 0) + rpcUiAmount(b));
    }
    for (const b of result.meta.postTokenBalances || []) {
      if (tokenOwner(b, accountKeys) !== owner || !b.mint) continue;
      postMap.set(b.mint, (postMap.get(b.mint) || 0) + rpcUiAmount(b));
    }
    for (const mint of new Set([...preMap.keys(), ...postMap.keys()])) {
      const delta = (postMap.get(mint) || 0) - (preMap.get(mint) || 0);
      if (!delta) continue;
      if (delta < 0) {
        tokenTransfers.push({ fromUserAccount: owner, mint, tokenAmount: Math.abs(delta) });
      } else {
        tokenTransfers.push({ toUserAccount: owner, mint, tokenAmount: delta });
      }
    }
  }

  const nativeTransfers = [];
  const pre = result.meta.preBalances || [];
  const post = result.meta.postBalances || [];
  const fee = Number(result.meta.fee || 0);
  for (let i = 0; i < accountKeys.length; i++) {
    let delta = (post[i] || 0) - (pre[i] || 0);
    if (i === 0) delta += fee;
    if (!delta) continue;
    if (delta < 0) nativeTransfers.push({ fromUserAccount: accountKeys[i], amount: Math.abs(delta) });
    if (delta > 0) nativeTransfers.push({ toUserAccount: accountKeys[i], amount: delta });
  }

  if (!tokenTransfers.length) return null;

  return {
    signature: sig || result.transaction?.signatures?.[0] || null,
    type: "UNKNOWN",
    feePayer,
    tokenTransfers,
    nativeTransfers,
    description: null,
  };
}

export function workerWebhookUrl(env, request) {
  const base = String(env.WORKER_URL || (request ? new URL(request.url).origin : "")).replace(
    /\/$/,
    ""
  );
  return `${base}/helius-webhook`;
}
