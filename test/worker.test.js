import { describe, expect, it } from "vitest";
import worker from "../index.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function dexResponse(symbol, name, mint) {
  return jsonResponse({
    pairs: [
      {
        chainId: "solana",
        liquidity: { usd: 9000 },
        baseToken: { address: mint, symbol, name },
        quoteToken: {
          address: "So11111111111111111111111111111111111111112",
          symbol: "SOL",
        },
        priceUsd: "0.02",
        priceNative: "0.000133333333",
        marketCap: 66469,
        pairCreatedAt: Date.now() - 3 * 86400 * 1000,
      },
    ],
  });
}

function mockEnv() {
  const personas = new Map();
  const seenTheses = new Map();
  const pollState = { webhook_cleared: 1, telegram_offset: 0, helius_webhook_id: null };

  const db = {
    _personas: personas,
    _seenTheses: seenTheses,
    prepare(sql) {
      return {
        bind(...args) {
          this._args = args;
          return this;
        },
        async first() {
          if (sql.includes("FROM poll_state")) return pollState;
          if (sql.includes("FROM seen_theses")) {
            return seenTheses.get(this._args?.[0]) ?? null;
          }
          if (sql.includes("FROM personas WHERE handle")) {
            const handle = this._args?.[0];
            return personas.get(handle) ?? null;
          }
          return null;
        },
        async all() {
          if (sql.includes("FROM seen_theses")) {
            return {
              results: (this._args || []).map((id) => seenTheses.get(id)).filter(Boolean),
            };
          }
          return { results: [...personas.values()] };
        },
        async run() {
          if (sql.includes("CREATE TABLE")) {
            return { success: true };
          }
          if (sql.includes("INSERT OR IGNORE INTO seen_theses") || sql.includes("INSERT INTO seen_theses")) {
            const [id, handle, seen_at] = this._args;
            if (id && !seenTheses.has(id)) seenTheses.set(id, { id, handle, seen_at });
            return { success: true };
          }
          if (sql.includes("SET fomo_id")) {
            const [fomoId, handle] = this._args;
            const row = personas.get(handle);
            if (row) row.fomo_id = fomoId;
            return { success: true };
          }
          if (sql.startsWith("INSERT INTO personas")) {
            const [handle, fomo_id, name, solana_address, evm_address, chat_id, created_at] =
              this._args;
            personas.set(handle, {
              handle,
              fomo_id,
              name,
              solana_address,
              evm_address,
              chat_id,
              created_at,
              last_signature: null,
            });
          }
          if (sql.includes("SET last_signature") && this._args?.length === 2) {
            const [sig, handle] = this._args;
            const row = personas.get(handle);
            if (row) row.last_signature = sig;
          }
          if (sql.includes("SET last_test_at")) {
            const next = this._args?.[0];
            const cutoff = this._args?.[1];
            if (pollState.last_test_at && cutoff && pollState.last_test_at >= cutoff) {
              return { success: true, meta: { changes: 0 } };
            }
            pollState.last_test_at = next;
            return { success: true, meta: { changes: 1 } };
          }
          if (sql.includes("SET last_webhook")) {
            pollState.last_webhook_at = this._args?.[0];
            pollState.last_webhook_note = this._args?.[1];
          }
          if (sql.includes("SET helius_webhook_id")) {
            pollState.helius_webhook_id = this._args?.[0];
          }
          return { success: true };
        },
      };
    },
  };

  return {
    FOMOSCAN_KEY: "fsk_test",
    TELEGRAM_BOT_TOKEN: "tg-token",
    TELEGRAM_CHAT_ID: "-1004446376533",
    HELIUS_API_KEY: "helius-test",
    WORKER_URL: "https://fomo-tracker.pintosdsgn.workers.dev",
    DB: db,
  };
}

describe("POST /helius-webhook", () => {
  it("posts a clan BUY alert for a tracked wallet", async () => {
    const sent = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const href = String(url);
      if (href.includes("dexscreener.com")) {
        return dexResponse("BONK", "Bonk", "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263");
      }
      if (href.includes("/leaderboard/clans")) {
        return jsonResponse({
          window: "24h",
          entries: [
            {
              id: "e0767d97-696f-46aa-9db4-c5f10578691a",
              label: "The Circle",
              rank: 71,
              pnl: -2508,
              memberCount: 8,
            },
          ],
        });
      }
      if (href.includes("api.telegram.org") && href.includes("sendMessage")) {
        sent.push(JSON.parse(init.body));
        return jsonResponse({ ok: true, result: { message_id: 2 } });
      }
      return jsonResponse({ ok: false }, 404);
    };

    const env = mockEnv();
    env.DB._personas.set("frejoshi", {
      handle: "frejoshi",
      solana_address: "GJt9wpQS6oxpmazcnc1WYLdxQsVAMxsNGynVcLQHmWH3",
      chat_id: "-1004446376533",
      last_signature: null,
    });

    try {
      const res = await worker.fetch(
        new Request("https://fomo-tracker.pintosdsgn.workers.dev/helius-webhook", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify([
            {
              type: "SWAP",
              signature: "realSig111",
              feePayer: "GJt9wpQS6oxpmazcnc1WYLdxQsVAMxsNGynVcLQHmWH3",
              description: "Swapped 1 SOL for 100 BONK on Jupiter",
              events: {
                swap: {
                  nativeInput: { amount: 1e9 },
                  tokenOutputs: [
                    { mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", tokenAmount: 100 },
                  ],
                },
              },
            },
          ]),
        }),
        env
      );
      expect(res.status).toBe(200);
      expect(sent).toHaveLength(1);
      expect(sent[0].parse_mode).toBe("HTML");
      expect(sent[0].text).toContain("📣 <b>The Circle</b>");
      expect(sent[0].text).toContain("Rank #71");
      expect(sent[0].text).toContain("🎯 Member: @frejoshi");
      expect(sent[0].text).toContain("📈 Action: BUY");
      expect(sent[0].text).toContain("BONK");
      expect(sent[0].text).toContain("💰 Amount: $150  |  1 SOL");
      expect(sent[0].text).toContain("📊 Mcap: $66,469");
      expect(sent[0].text).toContain("💧 Liquidity: $9,000");
      expect(sent[0].text).toContain("⏱ Age: 3d");
      expect(sent[0].text).not.toContain("Swapped 1 SOL");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("alerts on a SWAP from IssaTheCooker's Solana wallet", async () => {
    const issaSol = "8vjjczPfqznE2TLPekRyiySTGhX7e4MUVh5cYSHNtDuL";
    const sent = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const href = String(url);
      if (href.includes("dexscreener.com")) {
        return dexResponse("BONK", "Bonk", "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263");
      }
      if (href.includes("/leaderboard/clans")) {
        return jsonResponse({
          window: "24h",
          entries: [
            {
              id: "e0767d97-696f-46aa-9db4-c5f10578691a",
              label: "The Circle",
              rank: 78,
              pnl: -1710,
              memberCount: 8,
            },
          ],
        });
      }
      if (href.includes("api.telegram.org") && href.includes("sendMessage")) {
        sent.push(JSON.parse(init.body));
        return jsonResponse({ ok: true, result: { message_id: 3 } });
      }
      return jsonResponse({ ok: false }, 404);
    };

    const env = mockEnv();
    env.DB._personas.set("issathecooker", {
      handle: "issathecooker",
      solana_address: issaSol,
      chat_id: "-1004446376533",
      last_signature: null,
    });

    try {
      const res = await worker.fetch(
        new Request("https://fomo-tracker.pintosdsgn.workers.dev/helius-webhook", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify([
            {
              type: "SWAP",
              signature: "issaSwapSig1",
              feePayer: issaSol,
              description: "Swapped 1 SOL for 100 BONK on Jupiter",
              events: {
                swap: {
                  nativeInput: { amount: 1e9 },
                  tokenOutputs: [
                    { mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", tokenAmount: 100 },
                  ],
                },
              },
            },
          ]),
        }),
        env
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        ok: true,
        count: 1,
        notes: [{ skipped: false, reason: "alerted", alerts: 1 }],
      });
      expect(body.notes[0].matched).toEqual([
        { handle: "issathecooker", reason: "alerted" },
      ]);
      expect(sent).toHaveLength(1);
      expect(sent[0].text).toContain("🎯 Member: @issathecooker");
      expect(sent[0].text).toContain("📈 Action: BUY");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("alerts on an UNKNOWN DFlow aggregator swap for a tracked wallet", async () => {
    const sent = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const href = String(url);
      if (href.includes("dexscreener.com")) {
        return dexResponse("CYBERLEEK", "CYBERLEEK", "So11111111111111111111111111111111111111113");
      }
      if (href.includes("/leaderboard/clans")) {
        return jsonResponse({
          window: "24h",
          entries: [
            {
              id: "e0767d97-696f-46aa-9db4-c5f10578691a",
              label: "The Circle",
              rank: 71,
              pnl: -2508,
              memberCount: 8,
            },
          ],
        });
      }
      if (href.includes("api.telegram.org") && href.includes("sendMessage")) {
        sent.push(JSON.parse(init.body));
        return jsonResponse({ ok: true, result: { message_id: 3 } });
      }
      return jsonResponse({ ok: false }, 404);
    };

    const env = mockEnv();
    env.DB._personas.set("frejoshi", {
      handle: "frejoshi",
      solana_address: "GJt9wpQS6oxpmazcnc1WYLdxQsVAMxsNGynVcLQHmWH3",
      chat_id: "-1004446376533",
      last_signature: null,
    });

    try {
      const res = await worker.fetch(
        new Request("https://fomo-tracker.pintosdsgn.workers.dev/helius-webhook", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify([
            {
              type: "UNKNOWN",
              signature: "dflowSig222",
              feePayer: "GJt9wpQS6oxpmazcnc1WYLdxQsVAMxsNGynVcLQHmWH3",
              description: "Swapped 101.45 CYBERLEEK for 1.99 USDC on DFlow Aggregator v4",
              tokenTransfers: [
                {
                  fromUserAccount: "GJt9wpQS6oxpmazcnc1WYLdxQsVAMxsNGynVcLQHmWH3",
                  mint: "So11111111111111111111111111111111111111113",
                  tokenAmount: 101.45,
                },
                {
                  toUserAccount: "GJt9wpQS6oxpmazcnc1WYLdxQsVAMxsNGynVcLQHmWH3",
                  mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
                  tokenAmount: 1.99,
                },
              ],
            },
          ]),
        }),
        env
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, count: 1 });
      expect(sent).toHaveLength(1);
      expect(sent[0].text).toContain("🎯 Member: @frejoshi");
      expect(sent[0].text).toContain("📉 Action: SELL");
      expect(sent[0].text).toContain("CYBERLEEK");
      expect(sent[0].text).toContain("💰 Amount: $1.99  |  1.99 USDC");
      expect(sent[0].text).not.toContain("EPjFWdd5");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("GET /test", () => {
  it("sends a clan test alert to the group", async () => {
    const sent = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const href = String(url);
      if (href.includes("/leaderboard/clans")) {
        return jsonResponse({
          window: "24h",
          entries: [
            {
              id: "e0767d97-696f-46aa-9db4-c5f10578691a",
              label: "The Circle",
              rank: 14,
              pnl: 12400,
              memberCount: 8,
            },
          ],
        });
      }
      if (href.includes("api.telegram.org") && href.includes("sendMessage")) {
        const body = JSON.parse(init.body);
        sent.push(body);
        return jsonResponse({ ok: true, result: { message_id: 1 } });
      }
      return jsonResponse({ ok: false }, 404);
    };

    try {
      const res = await worker.fetch(
        new Request("https://fomo-tracker.test/test"),
        mockEnv()
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(sent).toHaveLength(1);
      expect(sent[0].parse_mode).toBe("HTML");
      expect(sent[0].text).toContain("📣 <b>The Circle</b>");
      expect(sent[0].text).toContain("🎯 Member: @frejoshi");
      expect(sent[0].text).toContain("🔭 Test ping");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not send twice for a second GET /test within a few seconds", async () => {
    const sent = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const href = String(url);
      if (href.includes("/leaderboard/clans")) {
        return jsonResponse({
          window: "24h",
          entries: [{ id: "e0767d97-696f-46aa-9db4-c5f10578691a", label: "The Circle", rank: 1, pnl: 1, memberCount: 1 }],
        });
      }
      if (href.includes("api.telegram.org") && href.includes("sendMessage")) {
        sent.push(JSON.parse(init.body));
        return jsonResponse({ ok: true, result: { message_id: 9 } });
      }
      return jsonResponse({ ok: false }, 404);
    };

    const env = mockEnv();
    try {
      const req = () => new Request("https://fomo-tracker.test/test");
      expect((await worker.fetch(req(), env)).status).toBe(200);
      const second = await worker.fetch(req(), env);
      expect(second.status).toBe(200);
      expect(await second.json()).toMatchObject({ ok: true, deduped: true });
      expect(sent).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("GET /test-thesis", () => {
  it("sends a readable thesis ping to the group", async () => {
    const sent = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const href = String(url);
      if (href.includes("dexscreener.com")) {
        return dexResponse("BONK", "Bonk", "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263");
      }
      if (href.includes("/leaderboard/clans")) {
        return jsonResponse({
          window: "24h",
          entries: [
            {
              id: "e0767d97-696f-46aa-9db4-c5f10578691a",
              label: "The Circle",
              rank: 14,
              pnl: 12400,
              memberCount: 8,
            },
          ],
        });
      }
      if (href.includes("api.telegram.org") && href.includes("sendMessage")) {
        sent.push(JSON.parse(init.body));
        return jsonResponse({ ok: true, result: { message_id: 11 } });
      }
      return jsonResponse({ ok: false }, 404);
    };

    try {
      const res = await worker.fetch(
        new Request("https://fomo-tracker.test/test-thesis"),
        mockEnv()
      );
      expect(res.status).toBe(200);
      expect(sent).toHaveLength(1);
      expect(sent[0].parse_mode).toBe("HTML");
      expect(sent[0].text).toContain("🎯 @frejoshi");
      expect(sent[0].text).toContain("<blockquote>");
      expect(sent[0].text).toContain("this will cook");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("GET /theses", () => {
  const FOMO_ID = "11111111-1111-4111-8111-111111111111";
  const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
  const oldThesis = {
    id: "old-th",
    authorHandle: "frejoshi",
    authorId: FOMO_ID,
    thesis: "already posted",
    tokenAddress: BONK,
    tokenNetwork: "sol",
    tokenSymbol: "BONK",
    authorTradeUsd: 10,
  };
  const newThesis = {
    id: "new-th",
    authorHandle: "frejoshi",
    authorId: FOMO_ID,
    thesis: "fresh take, this will cook",
    tokenAddress: BONK,
    tokenNetwork: "sol",
    tokenSymbol: "BONK",
    authorTradeUsd: 420,
  };

  function thesisFetch(sent, pageItems) {
    return async (url, init) => {
      const href = String(url);
      if (href.includes("/thesis/user/")) {
        return jsonResponse({ items: pageItems, hasMore: false, nextBefore: null });
      }
      if (href.includes("/v2/thesis")) {
        return jsonResponse({ items: [], hasMore: false, nextBefore: null });
      }
      if (href.includes("dexscreener.com")) {
        return dexResponse("BONK", "Bonk", BONK);
      }
      if (href.includes("/leaderboard/clans")) {
        return jsonResponse({
          window: "24h",
          entries: [
            {
              id: "e0767d97-696f-46aa-9db4-c5f10578691a",
              label: "The Circle",
              rank: 14,
              pnl: 12400,
              memberCount: 8,
            },
          ],
        });
      }
      if (href.includes("api.telegram.org") && href.includes("sendMessage")) {
        sent.push(JSON.parse(init.body));
        return jsonResponse({ ok: true, result: { message_id: 12 } });
      }
      return jsonResponse({ ok: false }, 404);
    };
  }

  it("primes on the first poll and alerts every new thesis after that", async () => {
    const env = mockEnv();
    env.DB._personas.set("frejoshi", {
      handle: "frejoshi",
      fomo_id: FOMO_ID,
      solana_address: "GJt9wpQS6oxpmazcnc1WYLdxQsVAMxsNGynVcLQHmWH3",
      chat_id: "-1004446376533",
    });

    const originalFetch = globalThis.fetch;
    try {
      const firstSent = [];
      globalThis.fetch = thesisFetch(firstSent, [oldThesis]);
      const first = await worker.fetch(new Request("https://fomo-tracker.test/theses"), env);
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({ ok: true, alerts: 0 });
      expect(firstSent).toHaveLength(0);

      const secondSent = [];
      globalThis.fetch = thesisFetch(secondSent, [newThesis, oldThesis]);
      const second = await worker.fetch(new Request("https://fomo-tracker.test/theses"), env);
      expect(second.status).toBe(200);
      const body = await second.json();
      expect(body.alerts).toBe(1);
      expect(secondSent).toHaveLength(1);
      expect(secondSent[0].text).toContain("<blockquote>fresh take, this will cook</blockquote>");
      expect(secondSent[0].text).toContain("🎯 @frejoshi");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("GET /clan-update", () => {
  it("posts a clan snapshot ping", async () => {
    const sent = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const href = String(url);
      if (href.includes("/leaderboard/clans")) {
        return jsonResponse({
          window: "24h",
          entries: [
            {
              id: "e0767d97-696f-46aa-9db4-c5f10578691a",
              label: "The Circle",
              rank: 78,
              pnl: -1710,
              memberCount: 8,
            },
          ],
        });
      }
      if (href.includes("api.telegram.org") && href.includes("sendMessage")) {
        sent.push(JSON.parse(init.body));
        return jsonResponse({ ok: true, result: { message_id: 20 } });
      }
      return jsonResponse({ ok: false }, 404);
    };

    try {
      const res = await worker.fetch(
        new Request("https://fomo-tracker.test/clan-update"),
        mockEnv(),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.clan).toMatchObject({ name: "The Circle", rank: 78, pnl: -1710 });
      expect(sent).toHaveLength(1);
      expect(sent[0].parse_mode).toBe("HTML");
      expect(sent[0].text).toContain("🎯 Member List");
      expect(sent[0].text).toContain("Issa · @issathecooker");
      expect(sent[0].text).not.toContain("Snapshot");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not send twice within the dedup window", async () => {
    const sent = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const href = String(url);
      if (href.includes("/leaderboard/clans")) {
        return jsonResponse({
          window: "24h",
          entries: [
            {
              id: "e0767d97-696f-46aa-9db4-c5f10578691a",
              label: "The Circle",
              rank: 76,
              pnl: -2853,
              memberCount: 8,
            },
          ],
        });
      }
      if (href.includes("api.telegram.org") && href.includes("sendMessage")) {
        sent.push(JSON.parse(init.body));
        return jsonResponse({ ok: true, result: { message_id: 21 } });
      }
      return jsonResponse({ ok: false }, 404);
    };

    const env = mockEnv();
    try {
      const first = await worker.fetch(
        new Request("https://fomo-tracker.test/clan-update"),
        env,
      );
      const second = await worker.fetch(
        new Request("https://fomo-tracker.test/clan-update"),
        env,
      );
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({ ok: true });
      expect(await second.json()).toMatchObject({ ok: true, deduped: true });
      expect(sent).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("skips Telegram link-preview crawlers", async () => {
    const res = await worker.fetch(
      new Request("https://fomo-tracker.test/clan-update", {
        headers: { "user-agent": "TelegramBot (like TwitterBot)" },
      }),
      mockEnv(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, skipped: "preview crawler" });
  });
});
