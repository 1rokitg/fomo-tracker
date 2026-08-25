import { describe, expect, it, vi } from "vitest";
import config from "../config.json";
import {
  asSwapEvent,
  clanHeadline,
  collectTouchedAccounts,
  collectNewTheses,
  configHandleSet,
  configMembers,
  fetchClanSnapshot,
  formatClanAlert,
  formatClanDigest,
  formatThesisAlert,
  formatUsd,
  formatAge,
  formatMoney,
  FOMOSCAN_BASE,
  heliusEvents,
  ponderEvents,
  ponderPollPlan,
  normalizeHandle,
  pageNeedsOlderTheses,
  pickClanFromBoard,
  short,
  swapFocus,
  swapSide,
  synthesizeSwap,
  rpcToEnhanced,
  telegramHandleFor,
  thesisBody,
} from "../lib.js";

const CLAN_ID = "e0767d97-696f-46aa-9db4-c5f10578691a";

describe("normalizeHandle", () => {
  it("strips @ and lowercases", () => {
    expect(normalizeHandle("@1RokitG")).toBe("1rokitg");
  });

  it("trims empty to empty", () => {
    expect(normalizeHandle("  ")).toBe("");
  });
});

describe("config roster", () => {
  it("loads clan id and member handles from config.json", () => {
    expect(config.clanId).toBe(CLAN_ID);
    expect([...configHandleSet()]).toEqual([
      "frejoshi",
      "chapluvsnfts",
      "cryptoaxeig",
      "innerbigbass",
      "warrendeep",
      "pacophone007",
      "1rokitg",
      "issathecooker",
    ]);
  });

  it("maps fomo handle to telegramHandle when set", () => {
    expect(telegramHandleFor("frejoshi")).toBeNull();
    expect(telegramHandleFor("1rokitg")).toBe("rokitgg");
    const issa = configMembers().find((m) => m.handle === "issathecooker");
    expect(issa.name).toBe("Issa");
    expect(issa.solanaAddress).toBe("8vjjczPfqznE2TLPekRyiySTGhX7e4MUVh5cYSHNtDuL");
    expect(issa.evmAddress).toBe("0x33920d73156e9d9be3c1611402f696f21c27d367");
    expect(issa.fomoId).toBe("d1bceeb5-d74c-566a-b9ed-47e3e384b7f1");
  });
});

describe("formatUsd", () => {
  it("formats positive and negative PnL", () => {
    expect(formatUsd(12400.9)).toBe("+$12,401");
    expect(formatUsd(-50)).toBe("-$50");
  });

  it("returns n/a for junk", () => {
    expect(formatUsd(undefined)).toBe("n/a");
    expect(formatUsd("nope")).toBe("n/a");
  });
});

describe("formatAge", () => {
  it("renders pair age in compact units", () => {
    const now = 1_700_000_000_000;
    expect(formatAge(now - 5 * 60 * 1000, now)).toBe("5m");
    expect(formatAge(now - 3 * 3600 * 1000, now)).toBe("3h");
    expect(formatAge(now - 2 * 86400 * 1000, now)).toBe("2d");
  });
});

describe("formatMoney", () => {
  it("does not treat null as $0", () => {
    expect(formatMoney(null)).toBeNull();
    expect(formatMoney(undefined)).toBeNull();
    expect(formatMoney(0)).toBeNull();
    expect(formatMoney(1.9)).toBe("$1.9");
  });
});

describe("short", () => {
  it("abbreviates long addresses", () => {
    expect(short("So11111111111111111111111111111111111111112")).toBe(
      "So11…1112",
    );
  });

  it("handles missing", () => {
    expect(short(null)).toBe("unknown");
  });
});

describe("pickClanFromBoard", () => {
  const board = {
    board: "clans",
    window: "24h",
    capturedAt: 1755765600000,
    entries: [
      {
        rank: 14,
        id: CLAN_ID,
        handle: "the-circle",
        label: "The Circle",
        pnl: 12400.4,
        memberCount: 8,
      },
    ],
  };

  it("uses label, rank, and 24h pnl as source of truth", () => {
    const clan = pickClanFromBoard(board, CLAN_ID);
    expect(clan.found).toBe(true);
    expect(clan.name).toBe("The Circle");
    expect(clanHeadline(clan)).toBe(
      "The Circle · Rank #14 · +$12,400 PnL · 8 members",
    );
  });

  it("falls back when the clan is off the top 100", () => {
    const clan = pickClanFromBoard({ window: "24h", entries: [] }, CLAN_ID);
    expect(clan.found).toBe(false);
    expect(clanHeadline(clan)).toBe("Our clan · Rank");
  });
});

describe("formatClanDigest", () => {
  it("posts rank, pnl, and the config roster", () => {
    const text = formatClanDigest({
      clan: {
        found: true,
        name: "The Circle",
        rank: 78,
        pnl: -1710,
        memberCount: 8,
      },
    });
    expect(text).toContain("📣 <b>The Circle</b>");
    expect(text).toContain("Rank #78");
    expect(text).toContain("-$1,710");
    expect(text).toContain("8 members");
    expect(text).toContain("🎯 Member List");
    expect(text).not.toContain("Snapshot");
    expect(text).toContain("@frejoshi");
    expect(text).toContain("MOrt7997 · @chapluvsnfts");
    expect(text).toContain("RokitG · @rokitgg");
    expect(text).toContain("Issa · @issathecooker");
  });
});

describe("formatClanAlert", () => {
  const clan = {
    found: true,
    name: "The Circle",
    rank: 14,
    pnl: 12400,
    memberCount: 8,
  };
  const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
  const evt = {
    type: "SWAP",
    description: "Swapped 1 SOL for 100 BONK on Jupiter",
    signature: "abcSig",
    events: {
      swap: {
        tokenInputs: [
          {
            tokenAmount: 1,
            mint: "So11111111111111111111111111111111111111112",
          },
        ],
        tokenOutputs: [{ tokenAmount: 100, mint: BONK }],
      },
    },
  };

  it("frames config members as clan alerts", () => {
    const text = formatClanAlert({
      persona: { handle: "frejoshi" },
      evt,
      clan,
      isClanMember: true,
      token: {
        mint: BONK,
        symbol: "BONK",
        name: "Bonk",
        mcap: 66469,
        priceUsd: 0.12,
        solPriceUsd: 150,
        liquidity: 12400,
        pairCreatedAt: Date.now() - 2 * 86400 * 1000,
        holders: 1204,
        chainId: "solana",
      },
    });
    expect(text).toContain("📣 <b>The Circle</b>");
    expect(text).toContain("Rank #14 · +$12,400 · 8 members");
    expect(text).toContain("🟢 Bonk | BONK 🧬 Solana");
    expect(text).toContain(BONK);
    expect(text).not.toContain("<code>");
    expect(text).toContain("🎯 Member: @frejoshi");
    expect(text).toContain("📈 Action: BUY");
    expect(text).toContain("💰 Amount: $150  |  1 SOL");
    expect(text).toContain("📊 Mcap: $66,469");
    expect(text).toContain("💧 Liquidity: $12,400");
    expect(text).toContain("⏱ Age: 2d");
    expect(text).toContain("👥 Holders: 1,204");
    expect(text).toContain("solscan.io/tx/abcSig");
    expect(text).toContain("fomo.family/tokens/solana/");
    expect(text).toContain("fomo.family/r/1rokitg");
    expect(text).toContain("dexscreener.com/solana/");
    expect(text).not.toContain("Swapped 1 SOL");
  });

  it("labels /track extras separately", () => {
    const text = formatClanAlert({
      persona: { handle: "outsider" },
      evt: { description: "Swap detected" },
      clan,
      isClanMember: false,
    });
    expect(text).toContain("🎯 Member: @outsider (extra)");
    expect(text).not.toContain("📈 Action: BUY");
    expect(text).not.toContain("📉 Action: SELL");
    expect(text).not.toContain("💰 Amount: $0");
  });

  it("formats a test ping without token noise", () => {
    const text = formatClanAlert({
      persona: { handle: "frejoshi" },
      evt: { description: "Test ping — not a real swap." },
      clan,
      isClanMember: true,
    });
    expect(text).toContain("🎯 Member: @frejoshi");
    expect(text).toContain("🔭 Test ping");
    expect(text).toContain("fomo.family/r/1rokitg");
    expect(text).not.toContain("📈");
  });

  it("uses Base explorers for EVM swaps", () => {
    const mint = "0x1111111111111111111111111111111111111111";
    const wallet = "0x0cd99204838851F0A803389faC19b98FC439dbc6";
    const text = formatClanAlert({
      persona: { handle: "1rokitg", evmAddress: wallet },
      evt: {
        signature: "0xabcdefffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        chainId: "base",
        events: {
          swap: {
            tokenInputs: [
              {
                mint: "0x4200000000000000000000000000000000000006",
                tokenAmount: 0.01,
              },
            ],
            tokenOutputs: [{ mint, tokenAmount: 1000 }],
          },
        },
      },
      clan,
      isClanMember: true,
      token: {
        mint,
        symbol: "MEME",
        name: "Meme",
        mcap: 50000,
        chainId: "base",
        nativePriceUsd: 2000,
      },
    });
    expect(text).toContain("🟢 Meme | MEME 🧬 Base");
    expect(text).toContain("📈 Action: BUY");
    expect(text).toContain("💰 Amount: $20  |  0.01 ETH");
    expect(text).toContain("basescan.org/tx/");
    expect(text).toContain("basescan.org/address/");
    expect(text).toContain("fomo.family/tokens/base/");
    expect(text).not.toContain("solscan.io");
  });
});

describe("formatThesisAlert", () => {
  const clan = {
    found: true,
    name: "The Circle",
    rank: 14,
    pnl: 12400,
    memberCount: 8,
  };
  const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
  const thesis = {
    id: "th1",
    authorHandle: "1rokitg",
    thesis: "this will cook\nsize in",
    tokenAddress: BONK,
    tokenNetwork: "sol",
    tokenSymbol: "BONK",
    authorTradeUsd: 420,
  };

  it("puts the thesis in a blockquote so it is the readable center of the ping", () => {
    const text = formatThesisAlert({
      persona: { handle: "frejoshi" },
      thesis,
      clan,
      isClanMember: true,
      token: { mint: BONK, symbol: "BONK", name: "Bonk", mcap: 66469 },
    });
    expect(text).toContain("📣 <b>The Circle</b>");
    expect(text).toContain("Rank #14 · +$12,400 · 8 members");
    expect(text).toContain("BONK | Bonk");
    expect(text).toContain(BONK);
    expect(text).not.toContain("<code>");
    expect(text).toContain("🎯 @frejoshi");
    expect(text).toContain("<blockquote>this will cook\nsize in</blockquote>");
    expect(text).toContain("💰 $420");
    expect(text).toContain("📊 $66,469");
    expect(text).toContain("fomo.family/tokens/solana/");
    expect(text).not.toContain("solscan.io");
    expect(text.indexOf("🎯 @frejoshi")).toBeLessThan(
      text.indexOf("<blockquote>"),
    );
  });

  it("escapes HTML in the thesis body", () => {
    const text = formatThesisAlert({
      persona: { handle: "frejoshi" },
      thesis: { ...thesis, thesis: "buy <b>now</b> & moon" },
      clan,
      isClanMember: true,
    });
    expect(text).toContain("buy &lt;b&gt;now&lt;/b&gt; &amp; moon");
  });

  it("still pings when the thesis text is empty", () => {
    const text = formatThesisAlert({
      persona: { handle: "frejoshi" },
      thesis: { ...thesis, thesis: "  " },
      clan,
      isClanMember: true,
    });
    expect(text).toContain("🎯 @frejoshi");
    expect(text).toContain("📝 Thesis");
  });
});

describe("collectNewTheses", () => {
  it("returns new items oldest-first and stops at the first seen id", () => {
    const items = [
      { id: "c" },
      { id: "b" },
      { id: "a" },
      { id: "old" },
      { id: "older" },
    ];
    expect(collectNewTheses(items, new Set(["a"]))).toEqual([
      { id: "b" },
      { id: "c" },
    ]);
  });

  it("returns nothing when the newest item is already seen", () => {
    expect(
      collectNewTheses([{ id: "c" }, { id: "b" }], new Set(["c"])),
    ).toEqual([]);
  });
});

describe("pageNeedsOlderTheses", () => {
  it("fetches older pages only when the whole page is unseen", () => {
    expect(
      pageNeedsOlderTheses(
        { hasMore: true, items: [{ id: "n1" }, { id: "n2" }] },
        new Set(),
      ),
    ).toBe(true);
    expect(
      pageNeedsOlderTheses(
        { hasMore: true, items: [{ id: "n1" }, { id: "old" }] },
        new Set(["old"]),
      ),
    ).toBe(false);
  });
});

describe("thesisBody", () => {
  it("prefers thesis text then segments", () => {
    expect(thesisBody({ thesis: " hello " })).toBe("hello");
    expect(thesisBody({ segments: [{ text: "a" }, { text: "b" }] })).toBe("ab");
  });
});

describe("swapSide", () => {
  const WSOL = "So11111111111111111111111111111111111111112";
  const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

  it("is BUY when spending SOL for a token", () => {
    expect(
      swapSide({
        events: {
          swap: {
            nativeInput: { amount: 1e9 },
            tokenOutputs: [{ mint: BONK, tokenAmount: 100 }],
          },
        },
      }),
    ).toBe("BUY");
  });

  it("is SELL when selling a token for SOL", () => {
    expect(
      swapSide({
        events: {
          swap: {
            tokenInputs: [{ mint: BONK, tokenAmount: 100 }],
            nativeOutput: { amount: 1e9 },
          },
        },
      }),
    ).toBe("SELL");
  });

  it("is null for quote-to-quote (SOL/USDC)", () => {
    expect(
      swapSide({
        events: {
          swap: {
            tokenInputs: [{ mint: WSOL, tokenAmount: 1 }],
            tokenOutputs: [
              {
                mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
                tokenAmount: 100,
              },
            ],
          },
        },
      }),
    ).toBeNull();
  });
});

describe("synthesizeSwap", () => {
  const owner = "GJt9wpQS6oxpmazcnc1WYLdxQsVAMxsNGynVcLQHmWH3";
  const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const CYBER = "So11111111111111111111111111111111111111113";

  it("rebuilds a SELL from DFlow-style tokenTransfers typed UNKNOWN", () => {
    const evt = {
      type: "UNKNOWN",
      feePayer: owner,
      description:
        "Swapped 101.45 CYBERLEEK for 1.99 USDC on DFlow Aggregator v4",
      tokenTransfers: [
        { fromUserAccount: owner, mint: CYBER, tokenAmount: 101.45 },
        { toUserAccount: owner, mint: USDC, tokenAmount: 1.99 },
      ],
    };
    const swap = asSwapEvent(evt);
    expect(swap).not.toBeNull();
    expect(swap.type).toBe("SWAP");
    expect(swapSide(swap)).toBe("SELL");
    expect(synthesizeSwap(evt).tokenInputs[0].mint).toBe(CYBER);
  });

  it("ignores a hollow Helius SWAP and rebuilds from tokenTransfers", () => {
    const owner = "GJt9wpQS6oxpmazcnc1WYLdxQsVAMxsNGynVcLQHmWH3";
    const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const CYBER = "ApZuxdpzMrbEYTGEzeY9afh5pj9d6qPRJCTgQYiipbKg";
    const swap = asSwapEvent({
      type: "SWAP",
      feePayer: owner,
      events: { swap: { tokenInputs: [], tokenOutputs: [], nativeInput: { amount: 0 } } },
      tokenTransfers: [
        { fromUserAccount: owner, mint: USDC, tokenAmount: 2 },
        { toUserAccount: owner, mint: CYBER, tokenAmount: 113.18 },
      ],
    });
    expect(swapSide(swap)).toBe("BUY");
    expect(swap.events.swap.tokenOutputs[0].mint).toBe(CYBER);
  });

  it("nets FOMO USD1 hops so a $2 SELL is the meme, not USD1", () => {
    const owner = "GJt9wpQS6oxpmazcnc1WYLdxQsVAMxsNGynVcLQHmWH3";
    const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const USD1 = "USD1ttGY1N17NEEHlmELoaybftRBUSerhqYiQzvEmuB";
    const MEME = "MemeToken111111111111111111111111111111111";
    const swap = asSwapEvent({
      type: "SWAP",
      feePayer: owner,
      events: {
        swap: {
          tokenInputs: [{ mint: USDC, tokenAmount: 0.1 }],
          tokenOutputs: [{ mint: USD1, tokenAmount: 0.1 }],
        },
      },
      tokenTransfers: [
        { fromUserAccount: owner, mint: MEME, tokenAmount: 50 },
        { toUserAccount: owner, mint: USDC, tokenAmount: 2 },
        { fromUserAccount: owner, mint: USDC, tokenAmount: 0.1 },
        { toUserAccount: owner, mint: USD1, tokenAmount: 0.1 },
        { fromUserAccount: owner, mint: USD1, tokenAmount: 0.1 },
      ],
    });
    expect(swapSide(swap)).toBe("SELL");
    expect(swapFocus(swap).token.mint).toBe(MEME);
    expect(swapFocus(swap).quote.mint).toBe(USDC);
    expect(swapFocus(swap).quote.tokenAmount).toBeCloseTo(1.9);
    const text = formatClanAlert({
      persona: { handle: "1rokitg", solanaAddress: owner },
      evt: swap,
      clan: { found: true, name: "The Circle", rank: 78, pnl: -1, memberCount: 8 },
      isClanMember: true,
      token: { mint: MEME, symbol: "MEME", name: "Meme", mcap: 5000, holders: 0, chainId: "solana" },
    });
    expect(text).toContain("📉 Action: SELL");
    expect(text).toContain("MEME");
    expect(text).not.toContain("USD1");
    expect(text).toContain("💰 Amount: $1.9  |  1.9 USDC");
    expect(text).not.toContain("Holders");
  });

  it("rebuilds a SELL from ATA tokenBalanceChanges when transfers omit the wallet", () => {
    const owner = "GJt9wpQS6oxpmazcnc1WYLdxQsVAMxsNGynVcLQHmWH3";
    const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const CYBER = "So11111111111111111111111111111111111111113";
    const swap = asSwapEvent({
      type: "UNKNOWN",
      feePayer: owner,
      accountData: [
        {
          account: "SomeTokenAccount111111111111111111111111111",
          tokenBalanceChanges: [
            {
              userAccount: owner,
              mint: CYBER,
              rawTokenAmount: { tokenAmount: "-101450199858", decimals: 9 },
            },
            {
              userAccount: owner,
              mint: USDC,
              rawTokenAmount: { tokenAmount: "1992718", decimals: 6 },
            },
          ],
        },
      ],
    });
    expect(swap).not.toBeNull();
    expect(swapSide(swap)).toBe("SELL");
  });

  it("ignores a plain SOL transfer", () => {
    expect(
      synthesizeSwap({
        feePayer: owner,
        nativeTransfers: [{ fromUserAccount: owner, amount: 1e9 }],
      }),
    ).toBeNull();
  });
});

describe("rpcToEnhanced", () => {
  const owner = "GJt9wpQS6oxpmazcnc1WYLdxQsVAMxsNGynVcLQHmWH3";
  const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const CYBER = "So11111111111111111111111111111111111111113";

  it("turns pre/post token balances into a SELL", () => {
    const evt = rpcToEnhanced(
      {
        meta: {
          err: null,
          fee: 5000,
          preBalances: [1_000_000],
          postBalances: [995_000],
          preTokenBalances: [
            { owner, mint: CYBER, uiTokenAmount: { uiAmount: 101.45 } },
            { owner, mint: USDC, uiTokenAmount: { uiAmount: 0 } },
          ],
          postTokenBalances: [
            { owner, mint: CYBER, uiTokenAmount: { uiAmount: 0 } },
            { owner, mint: USDC, uiTokenAmount: { uiAmount: 1.99 } },
          ],
        },
        transaction: {
          message: { accountKeys: [owner] },
          signatures: ["dflowSig"],
        },
      },
      "dflowSig",
    );
    const swap = asSwapEvent(evt);
    expect(swapSide(swap)).toBe("SELL");
    expect(swap.feePayer).toBe(owner);
  });
});

describe("heliusEvents", () => {
  it("unwraps array, data[], or a single object", () => {
    expect(heliusEvents([{ type: "SWAP" }])).toHaveLength(1);
    expect(heliusEvents({ data: [{ type: "TRANSFER" }] })[0].type).toBe(
      "TRANSFER",
    );
    expect(heliusEvents({ type: "UNKNOWN" })[0].type).toBe("UNKNOWN");
  });
});

describe("ponderEvents", () => {
  const wallet = "0x0cd99204838851F0A803389faC19b98FC439dbc6";
  const meme = "0x1111111111111111111111111111111111111111";
  const weth = "0x4200000000000000000000000000000000000006";

  it("turns a Ponder Base swap row into a BUY", () => {
    const events = ponderEvents({
      swaps: [
        {
          id: "8453:0xdead",
          chainId: 8453,
          hash: "0xdead",
          wallet,
          tokenIn: weth,
          tokenInAmount: "0.01",
          tokenOut: meme,
          tokenOutAmount: "1000",
        },
      ],
    });
    const evt = events.find((e) => e.feePayer === wallet.toLowerCase());
    expect(evt).toBeTruthy();
    expect(evt.chainId).toBe("base");
    expect(evt.signature).toBe("0xdead");
    expect(swapSide(evt)).toBe("BUY");
    expect(swapFocus(evt).token.mint).toBe(meme);
  });
});

describe("ponderPollPlan", () => {
  const items = [{ id: "a" }, { id: "b" }];

  it("primes on the first page and does not replay", () => {
    expect(ponderPollPlan(items, null)).toEqual({
      rows: [],
      latest: "b",
      prime: true,
    });
  });

  it("returns new rows after a cursor", () => {
    expect(ponderPollPlan(items, "a")).toEqual({
      rows: items,
      latest: "b",
      prime: false,
    });
  });
});

describe("collectTouchedAccounts", () => {
  it("reads feePayer and accountData from enhanced events", () => {
    expect(
      collectTouchedAccounts({
        feePayer: "GJt9wpQS6oxpmazcnc1WYLdxQsVAMxsNGynVcLQHmWH3",
        accountData: [
          { account: "So11111111111111111111111111111111111111112" },
        ],
      }),
    ).toEqual([
      "GJt9wpQS6oxpmazcnc1WYLdxQsVAMxsNGynVcLQHmWH3",
      "So11111111111111111111111111111111111111112",
    ]);
  });
});

describe("fetchClanSnapshot", () => {
  it("requests the 24h clans board and picks our clan", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        window: "24h",
        entries: [
          {
            id: CLAN_ID,
            label: "The Circle",
            rank: 2,
            pnl: 10,
            memberCount: 1,
          },
        ],
      }),
    }));

    const clan = await fetchClanSnapshot(
      { FOMOSCAN_KEY: "fsk_test" },
      fetchImpl,
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      `${FOMOSCAN_BASE}/leaderboard/clans?window=24h`,
      expect.objectContaining({
        headers: { Authorization: "Bearer fsk_test" },
      }),
    );
    expect(clan.name).toBe("The Circle");
    expect(clan.rank).toBe(2);
  });

  it("marks not found on HTTP error", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => "nope",
    }));
    const clan = await fetchClanSnapshot({ FOMOSCAN_KEY: "bad" }, fetchImpl);
    expect(clan.found).toBe(false);
    expect(clan.id).toBe(CLAN_ID);
  });
});
