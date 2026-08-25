/**
 * fomo-tracker
 *
 * Swap feed is a Helius enhanced webhook on WORKER_URL/helius-webhook.
 * Thesis feed is FomoScan GET /v2/thesis, filtered to config.json members.
 *
 * Clan member handles live in config.json (FomoScan's clan board has no
 * roster). Each cron tick resolves new handles and refreshes the Helius
 * webhook address list. Telegram commands use getUpdates polling.
 *
 * Alerts are clan alerts: name / rank / 24h combined PnL come from
 * GET /v2/leaderboard/clans?window=24h keyed by config.clanId.
 *
 * FomoScan identity is handle <-> wallet. Swaps come from Helius.
 * Theses come from FomoScan's thesis feed (not on-chain).
 *
 * Routes:
 *   POST /helius-webhook — Helius enhanced SWAP webhooks
 *   GET  /setup          — Telegram polling + register Helius webhook on WORKER_URL
 *   GET  /test           — sample clan alert (no swap)
 *   GET  /test-thesis    — sample thesis alert
 *   GET  /theses         — run one thesis poll now (same as cron)
 *   GET  /replay         — inspect a signature (?sig=…&send=1 to also post)
 *   GET  /status         — Helius webhook + roster diagnostics (no Telegram)
 *   GET  /clan-update    — post rank / 24h PnL / member list (same as 6h cron)
 *   GET  /identities     — curl FomoScan GET /v2/user/handle/{handle} for the roster
 *   GET  /               — health check
 */

import {
  clanHeadline,
  collectTouchedAccounts,
  collectNewTheses,
  configMembers,
  configHandleSet,
  fetchClanSnapshot,
  fetchDexToken,
  fetchThesisFeed,
  fetchUserTheses,
  formatClanAlert,
  formatClanDigest,
  formatThesisAlert,
  fomoscanHeaders,
  FOMOSCAN_BASE,
  HELIUS_API_BASE,
  CLAN_DIGEST_CRON,
  asSwapEvent,
  rpcToEnhanced,
  heliusEvents,
  normalizeHandle,
  pageNeedsOlderTheses,
  primedThesisKey,
  CLAN_THESIS_FEED_KEY,
  short,
  swapFocus,
  swapSide,
  thesisClanMember,
  txSignature,
  workerWebhookUrl,
  HELIUS_HISTORY_BASE,
} from "./lib.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (request.method === "POST" && url.pathname === "/helius-webhook") {
        return await handleHeliusWebhook(request, env);
      }
      if (request.method === "GET" && url.pathname === "/setup") {
        return await handleSetup(request, env);
      }
      if (request.method === "GET" && url.pathname === "/test") {
        return await handleTest(request, env);
      }
      if (request.method === "GET" && url.pathname === "/test-thesis") {
        return await handleTestThesis(request, env);
      }
      if (request.method === "GET" && url.pathname === "/theses") {
        return await handleThesesPoll(request, env);
      }
      if (request.method === "GET" && url.pathname === "/replay") {
        return await handleReplay(request, env);
      }
      if (request.method === "GET" && url.pathname === "/status") {
        return await handleStatus(env, request);
      }
      if (request.method === "GET" && url.pathname === "/clan-update") {
        return await handleClanUpdate(request, env);
      }
      if (request.method === "GET" && url.pathname === "/identities") {
        return await handleIdentities(env);
      }
      return new Response("fomo-tracker: ok", { status: 200 });
    } catch (err) {
      console.error("Unhandled error:", err);
      return new Response(`internal error: ${err?.message || err}`, {
        status: 500,
      });
    }
  },

  async scheduled(controller, env) {
    if (controller?.cron === CLAN_DIGEST_CRON) {
      await postClanDigest(env);
      return;
    }
    await pollOnce(env);
  },
};

async function pollOnce(env) {
  await ensureTelegramPolling(env);
  await syncConfigHandles(env);
  await syncHeliusWebhook(env);
  try {
    await pollTheses(env);
  } catch (err) {
    console.error("thesis poll failed", err);
  }
  await pollTelegram(env);
}

function alertChatId(env) {
  return env.TELEGRAM_CHAT_ID ? String(env.TELEGRAM_CHAT_ID) : null;
}

/**
 * Ensure every handle in config.json is in D1 (resolve wallets via FomoScan).
 * FomoScan /v2/leaderboard/clans has no member roster, so this file is the list.
 */
async function syncConfigHandles(env, { notify = true } = {}) {
  const handles = configMembers();
  const added = [];
  const skipped = [];
  const failed = [];

  for (const member of handles) {
    const result = await upsertTrackedHandle(
      env,
      member.handle,
      member.solanaAddress,
      member.fomoId,
      member.evmAddress,
    );
    if (result.status === "added") added.push(result.handle);
    else if (result.status === "exists") skipped.push(result.handle);
    else failed.push(`${member.handle} (${result.reason})`);
  }

  if (added.length || failed.length) {
    console.log("config sync", { added, skipped: skipped.length, failed });
  }

  const dest = alertChatId(env);
  if (notify && dest && added.length) {
    await sendTelegram(
      env,
      dest,
      `Clan roster updated — now alerting on:\n${added.map((h) => `@${h}`).join("\n")}`,
    );
  }
  if (failed.length) {
    console.error("config sync failures:", failed);
  }

  return { added, skipped, failed, total: handles.length };
}

async function upsertTrackedHandle(
  env,
  handle,
  fallbackAddress = null,
  fallbackFomoId = null,
  fallbackEvm = null,
) {
  handle = normalizeHandle(handle);
  if (!handle) return { status: "error", reason: "empty handle" };

  const existing = await env.DB.prepare(
    "SELECT handle, fomo_id FROM personas WHERE handle = ?",
  )
    .bind(handle)
    .first();
  if (existing) {
    if (fallbackFomoId) {
      try {
        await env.DB.prepare("UPDATE personas SET fomo_id = ? WHERE handle = ?")
          .bind(fallbackFomoId, handle)
          .run();
      } catch (err) {
        console.error("fomo_id backfill skipped", err);
      }
    }
    if (fallbackAddress) {
      try {
        await env.DB.prepare(
          "UPDATE personas SET solana_address = ?, evm_address = COALESCE(?, evm_address) WHERE handle = ?",
        )
          .bind(fallbackAddress, fallbackEvm, handle)
          .run();
      } catch (err) {
        console.error("wallet backfill skipped", err);
      }
    }
    return { status: "exists", handle };
  }

  let persona = null;
  try {
    persona = await fomoscanGetHandle(env, handle);
  } catch (err) {
    if (err.status !== 404) {
      console.error("FomoScan error:", err);
      if (!fallbackAddress) {
        return {
          status: "error",
          handle,
          reason: `FomoScan ${err.status || "error"}`,
        };
      }
    }
  }

  const solanaAddress = persona?.solanaAddress || fallbackAddress;
  if (!solanaAddress) {
    if (!persona)
      return { status: "error", handle, reason: "not found on FomoScan" };
    return { status: "error", handle, reason: "no verified Solana wallet" };
  }

  const dest = alertChatId(env) || "";
  await env.DB.prepare(
    `INSERT INTO personas (handle, fomo_id, name, solana_address, evm_address, chat_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      handle,
      persona?.id ?? fallbackFomoId ?? null,
      persona?.name ?? null,
      solanaAddress,
      persona?.evmAddress ?? fallbackEvm ?? null,
      dest,
      new Date().toISOString(),
    )
    .run();

  return {
    status: "added",
    handle,
    persona: {
      ...(persona || {}),
      solanaAddress,
    },
  };
}

// ---------------------------------------------------------------------
// /setup — drop any leftover Telegram webhook and ping the group.
// Visit once after deploying (GET in a browser or curl).
// ---------------------------------------------------------------------
async function handleSetup(request, env) {
  const quiet = new URL(request.url).searchParams.get("ping") === "0";
  const deleted = await deleteTelegramWebhook(env);
  await markWebhookCleared(env);
  const sync = await syncConfigHandles(env, { notify: !quiet });
  const helius = await syncHeliusWebhook(env, request);
  const clan = await fetchClanSnapshot(env);
  const hookUrl = workerWebhookUrl(env, request);

  const groupId = alertChatId(env);
  let ping = null;
  if (groupId && !quiet) {
    ping = await sendTelegram(
      env,
      groupId,
      `Clan alerts are online for this chat.\n${clanHeadline(clan)}\nHelius webhook: ${hookUrl}\n${sync.total} member handle(s) in config.json.\n\nCommands: /test · /list · /track <handle> · /untrack <handle>`,
    );
  }

  return new Response(
    JSON.stringify(
      {
        telegram_webhook_deleted: deleted,
        helius_webhook_url: hookUrl,
        helius,
        group_chat_id: groupId,
        group_ping: ping,
        clan,
        config_sync: sync,
        note: "Paste helius_webhook_url in Helius if API registration fails. Prefer enhanced + Any (DFlow is often not typed SWAP).",
      },
      null,
      2,
    ),
    { headers: { "Content-Type": "application/json" } },
  );
}

async function handleTest(request, env) {
  const ua = request.headers.get("user-agent") || "";
  if (/TelegramBot|facebookexternalhit|Twitterbot/i.test(ua)) {
    return new Response(
      JSON.stringify({ ok: true, skipped: "preview crawler" }),
      {
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  return sendTestAlert(env);
}

async function sendTestAlert(env) {
  const dest = alertChatId(env);
  if (!dest) {
    return new Response("TELEGRAM_CHAT_ID is not set", { status: 500 });
  }

  const claimed = await claimTestPing(env);
  if (!claimed) {
    return new Response(JSON.stringify({ ok: true, deduped: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const clan = await fetchClanSnapshot(env);
  const sampleHandle = [...configHandleSet()][0] || "member";
  const text = formatClanAlert({
    persona: { handle: sampleHandle },
    evt: { description: "Test ping — not a real swap." },
    clan,
    isClanMember: true,
  });
  const ping = await sendTelegram(env, dest, text, { parseMode: "HTML" });

  return new Response(
    JSON.stringify({ ok: ping?.ok === true, clan, ping }, null, 2),
    { headers: { "Content-Type": "application/json" } },
  );
}

const SAMPLE_THESIS = {
  id: "test-thesis",
  authorHandle: "1rokitg",
  thesis: "this will cook — size in, thesis stays on.",
  tokenAddress: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  tokenNetwork: "sol",
  tokenSymbol: "BONK",
  authorTradeUsd: 420,
};

async function handleTestThesis(request, env) {
  const ua = request.headers.get("user-agent") || "";
  if (/TelegramBot|facebookexternalhit|Twitterbot/i.test(ua)) {
    return new Response(
      JSON.stringify({ ok: true, skipped: "preview crawler" }),
      {
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  const dest = alertChatId(env);
  if (!dest) {
    return new Response("TELEGRAM_CHAT_ID is not set", { status: 500 });
  }

  const clan = await fetchClanSnapshot(env);
  const sampleHandle = [...configHandleSet()][0] || "member";
  let token = null;
  try {
    token = await fetchDexToken(
      SAMPLE_THESIS.tokenAddress,
      fetch,
      SAMPLE_THESIS.tokenNetwork,
    );
  } catch (err) {
    console.error("test-thesis token lookup failed", err);
  }
  const text = formatThesisAlert({
    persona: { handle: sampleHandle },
    thesis: SAMPLE_THESIS,
    clan,
    isClanMember: true,
    token: token || {
      mint: SAMPLE_THESIS.tokenAddress,
      symbol: "BONK",
      name: "Bonk",
      mcap: 66469,
    },
  });
  const ping = await sendTelegram(env, dest, text, { parseMode: "HTML" });
  return new Response(
    JSON.stringify(
      { ok: ping?.ok === true, clan, ping, preview: text },
      null,
      2,
    ),
    {
      headers: { "Content-Type": "application/json" },
    },
  );
}

async function handleThesesPoll(request, env) {
  const ua = request.headers.get("user-agent") || "";
  if (/TelegramBot|facebookexternalhit|Twitterbot/i.test(ua)) {
    return new Response(
      JSON.stringify({ ok: true, skipped: "preview crawler" }),
      {
        headers: { "Content-Type": "application/json" },
      },
    );
  }
  await syncConfigHandles(env, { notify: false });
  const result = await pollTheses(env);
  return new Response(JSON.stringify({ ok: true, ...result }, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
}

const MAX_THESIS_PAGES = 5;

async function ensureThesisTable(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS seen_theses (
      id TEXT PRIMARY KEY,
      handle TEXT NOT NULL,
      seen_at TEXT NOT NULL
    )`,
  ).run();
}

async function isThesisPrimed(env, key) {
  const row = await env.DB.prepare("SELECT id FROM seen_theses WHERE id = ?")
    .bind(key)
    .first();
  return Boolean(row);
}

async function markThesesSeen(env, handle, ids) {
  const now = new Date().toISOString();
  for (const id of ids) {
    if (!id) continue;
    await env.DB.prepare(
      "INSERT OR IGNORE INTO seen_theses (id, handle, seen_at) VALUES (?, ?, ?)",
    )
      .bind(id, handle, now)
      .run();
  }
}

async function seenThesisIdSet(env, ids) {
  const wanted = [...new Set((ids || []).filter(Boolean))];
  const seen = new Set();
  if (!wanted.length) return seen;
  const placeholders = wanted.map(() => "?").join(",");
  try {
    const { results } = await env.DB.prepare(
      `SELECT id FROM seen_theses WHERE id IN (${placeholders})`,
    )
      .bind(...wanted)
      .all();
    for (const row of results || []) seen.add(row.id);
  } catch (err) {
    console.error("seen thesis lookup failed", err);
  }
  return seen;
}

async function rememberFomoId(env, handle, fomoId) {
  if (!handle || !fomoId) return;
  try {
    await env.DB.prepare("UPDATE personas SET fomo_id = ? WHERE handle = ?")
      .bind(fomoId, handle)
      .run();
  } catch (err) {
    console.error("rememberFomoId skipped", err);
  }
}

async function resolvePersonaFomoId(env, persona) {
  if (persona.fomo_id) return persona.fomo_id;
  const fromConfig = configMembers().find(
    (m) => m.handle === normalizeHandle(persona.handle),
  );
  if (fromConfig?.fomoId) {
    await rememberFomoId(env, persona.handle, fromConfig.fomoId);
    return fromConfig.fomoId;
  }
  try {
    const rec = await fomoscanGetHandle(env, persona.handle);
    if (rec?.id) {
      await rememberFomoId(env, persona.handle, rec.id);
      return rec.id;
    }
  } catch (err) {
    if (err.status !== 404)
      console.error("resolve fomo_id failed", persona.handle, err);
  }
  return null;
}

async function loadThesisPagesForUser(env, userId, seenIds, firstPage) {
  const pages = [firstPage];
  let page = firstPage;
  for (let i = 1; i < MAX_THESIS_PAGES; i++) {
    if (!pageNeedsOlderTheses(page, seenIds)) break;
    const items = page.items || [];
    const before = page.nextBefore || items[items.length - 1]?.id;
    if (!before) break;
    page = await fetchUserTheses(env, userId, { before });
    pages.push(page);
  }
  return pages.flatMap((p) => p.items || []);
}

async function alertOnThesis(env, persona, thesis, clan) {
  const dest = alertChatId(env) || persona.chat_id;
  let token = null;
  try {
    token = await fetchDexToken(
      thesis?.tokenAddress,
      fetch,
      thesis?.tokenNetwork || "sol",
    );
  } catch (err) {
    console.error("thesis token lookup failed", err);
  }
  const text = formatThesisAlert({
    persona,
    thesis,
    clan,
    isClanMember: configHandleSet().has(normalizeHandle(persona.handle)),
    token,
  });
  await sendTelegram(env, dest, text, { parseMode: "HTML" });
}

async function pollHandleTheses(
  env,
  persona,
  clan,
  itemsNewestFirst,
  primedKey,
) {
  const handle = normalizeHandle(persona.handle);
  const ids = (itemsNewestFirst || []).map((t) => t.id).filter(Boolean);
  const primed = await isThesisPrimed(env, primedKey);

  if (!primed) {
    await markThesesSeen(env, handle, [primedKey, ...ids]);
    return { handle, primed: true, alerts: 0, scanned: ids.length };
  }

  const seen = await seenThesisIdSet(env, ids);
  const fresh = collectNewTheses(itemsNewestFirst, seen);
  let alerts = 0;
  for (const thesis of fresh) {
    await alertOnThesis(env, persona, thesis, clan);
    await markThesesSeen(env, handle, [thesis.id]);
    alerts += 1;
    if (thesis.authorId) await rememberFomoId(env, handle, thesis.authorId);
  }
  return { handle, primed: false, alerts, scanned: ids.length };
}

async function pollTheses(env) {
  await ensureThesisTable(env);
  let clan = { found: false };
  try {
    clan = (await fetchClanSnapshot(env)) || clan;
  } catch (err) {
    console.error("clan snapshot failed", err);
  }

  let personas = [];
  try {
    const { results } = await env.DB.prepare(
      "SELECT handle, fomo_id, chat_id FROM personas",
    ).all();
    personas = results || [];
  } catch (err) {
    console.error("persona list failed", err);
    return { alerts: 0, notes: [{ error: err.message }] };
  }

  const clanHandles = configHandleSet();
  const notes = [];
  let alerts = 0;

  for (const persona of personas) {
    if (!clanHandles.has(normalizeHandle(persona.handle))) continue;
    try {
      const fomoId = await resolvePersonaFomoId(env, persona);
      persona.fomo_id = fomoId || persona.fomo_id;
      if (!persona.fomo_id) {
        notes.push({
          handle: persona.handle,
          skipped: true,
          reason: "no_fomo_id",
        });
        continue;
      }
      const primedKey = primedThesisKey(persona.handle);
      const firstPage = await fetchUserTheses(env, persona.fomo_id);
      const primed = await isThesisPrimed(env, primedKey);
      const seenGuess = await seenThesisIdSet(
        env,
        (firstPage.items || []).map((t) => t.id),
      );
      const items = primed
        ? await loadThesisPagesForUser(
            env,
            persona.fomo_id,
            seenGuess,
            firstPage,
          )
        : firstPage.items || [];
      const note = await pollHandleTheses(env, persona, clan, items, primedKey);
      alerts += note.alerts;
      notes.push({ ...note, fomoId: persona.fomo_id });
    } catch (err) {
      console.error("thesis handle failed", persona.handle, err);
      notes.push({ handle: persona.handle, error: err.message });
    }
  }

  console.log("thesis-poll", { alerts, notes });
  return { alerts, notes };
}

const TEST_DEDUP_MS = 10_000;

async function claimTestPing(env) {
  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() - TEST_DEDUP_MS).toISOString();
  try {
    const result = await env.DB.prepare(
      "UPDATE poll_state SET last_test_at = ? WHERE id = 1 AND (last_test_at IS NULL OR last_test_at < ?)",
    )
      .bind(now, cutoff)
      .run();
    const changes = result?.meta?.changes ?? result?.changes;
    if (changes == null) return true;
    return changes > 0;
  } catch {
    return true;
  }
}

async function handleStatus(env, request) {
  let personas = [];
  try {
    const { results } = await env.DB.prepare(
      "SELECT handle, solana_address FROM personas ORDER BY created_at DESC",
    ).all();
    personas = results || [];
  } catch (err) {
    personas = [{ error: err.message }];
  }

  let poll = null;
  try {
    poll = await env.DB.prepare(
      "SELECT * FROM poll_state WHERE id = 1",
    ).first();
  } catch (err) {
    poll = { error: err.message };
  }

  const webhookId = poll?.helius_webhook_id || null;
  let helius = null;
  if (env.HELIUS_API_KEY && webhookId) {
    const res = await fetch(
      `${HELIUS_API_BASE}/webhooks/${webhookId}?api-key=${env.HELIUS_API_KEY}`,
    );
    const body = await res.json().catch(() => null);
    if (body?.authHeader) body.authHeader = "(set)";
    helius = { http: res.status, webhook: body };
  } else if (env.HELIUS_API_KEY) {
    const res = await fetch(
      `${HELIUS_API_BASE}/webhooks?api-key=${env.HELIUS_API_KEY}`,
    );
    const body = await res.json().catch(() => null);
    helius = { http: res.status, webhooks: body };
  }

  return new Response(
    JSON.stringify(
      {
        ok: true,
        workerUrl: workerWebhookUrl(env, request),
        chatId: alertChatId(env),
        config: configMembers().map((m) => ({
          handle: m.handle,
          telegramHandle: m.telegramHandle,
          solanaAddress: m.solanaAddress,
          evmAddress: m.evmAddress,
          fomoId: m.fomoId,
        })),
        personas,
        poll: {
          helius_webhook_id: webhookId,
          last_webhook_at: poll?.last_webhook_at || null,
          last_webhook_note: poll?.last_webhook_note || null,
        },
        helius,
      },
      null,
      2,
    ),
    { headers: { "Content-Type": "application/json" } },
  );
}

async function handleClanUpdate(request, env) {
  const ua = request.headers.get("user-agent") || "";
  if (/Telegram|facebookexternalhit|Twitterbot|Slackbot|Discordbot/i.test(ua)) {
    return new Response(
      JSON.stringify({ ok: true, skipped: "preview crawler" }),
      {
        headers: { "Content-Type": "application/json" },
      },
    );
  }
  const result = await postClanDigest(env);
  const status = result.ok ? 200 : 502;
  return new Response(JSON.stringify(result, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function postClanDigest(env) {
  const dest = alertChatId(env);
  if (!dest) return { ok: false, error: "TELEGRAM_CHAT_ID is not set" };

  const claimed = await claimTestPing(env);
  if (!claimed) return { ok: true, deduped: true };

  let clan = { found: false };
  try {
    clan = (await fetchClanSnapshot(env)) || clan;
  } catch (err) {
    console.error("clan digest snapshot failed", err);
  }

  const members = configMembers();
  const text = formatClanDigest({ clan, members });
  const ping = await sendTelegram(env, dest, text, { parseMode: "HTML" });
  return {
    ok: Boolean(ping?.ok),
    clan: {
      found: Boolean(clan?.found),
      name: clan?.name || null,
      rank: clan?.rank ?? null,
      pnl: clan?.pnl ?? null,
      memberCount: clan?.memberCount ?? null,
    },
    members: members.map((m) => ({
      handle: m.handle,
      name: m.name,
      telegramHandle: m.telegramHandle,
    })),
  };
}

async function handleIdentities(env) {
  const lookups = [];
  for (const member of configMembers()) {
    try {
      const rec = await fomoscanGetHandle(env, member.handle);
      lookups.push({
        query: member.handle,
        http: 200,
        id: rec.id,
        handle: rec.handle,
        name: rec.name,
        solanaAddress: rec.solanaAddress,
        evmAddress: rec.evmAddress,
      });
    } catch (err) {
      lookups.push({
        query: member.handle,
        http: err.status || 0,
        error: err.message,
      });
    }
  }
  return new Response(JSON.stringify({ ok: true, lookups }, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
}

async function handleReplay(request, env) {
  const sig = new URL(request.url).searchParams.get("sig");
  const shouldSend = new URL(request.url).searchParams.get("send") === "1";
  if (!sig) {
    return new Response("Usage: /replay?sig=<signature>&send=1", {
      status: 400,
    });
  }

  const parsed = await parseHeliusTx(env, sig);
  const evt = asSwapEvent(parsed);
  if (!evt) {
    return new Response(
      JSON.stringify(
        {
          ok: false,
          sig,
          error: "Helius did not parse this as a SWAP",
          parseError: parsed?.__parseError || null,
          rpcHasResult: parsed?.__rpcHasResult ?? null,
          rpcError: parsed?.__rpcError || null,
          preTokenBalances: parsed?.__pre ?? null,
          postTokenBalances: parsed?.__post ?? null,
          type: parsed?.type || null,
          source: parsed?.source || null,
          description: parsed?.description || null,
          feePayer: parsed?.feePayer || null,
          tokenTransferCount: parsed?.tokenTransfers?.length || 0,
          nativeTransferCount: parsed?.nativeTransfers?.length || 0,
          tokenTransfers: (parsed?.tokenTransfers || [])
            .slice(0, 8)
            .map((t) => ({
              from: t.fromUserAccount || null,
              to: t.toUserAccount || null,
              mint: t.mint || null,
              amount: t.tokenAmount ?? null,
            })),
        },
        null,
        2,
      ),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  }

  const touched = collectTouchedAccounts(evt);
  const watched = await getTrackedAddresses(env);
  const matched = watched.filter((addr) => touched.includes(addr));
  const clan = await fetchClanSnapshot(env);
  const token = await fetchDexToken(swapFocusMint(evt));
  const preview = formatClanAlert({
    persona: { handle: [...configHandleSet()][0] || "member" },
    evt,
    clan,
    isClanMember: true,
    token,
  });

  let ping = null;
  if (shouldSend) {
    await dispatchSwapAlert(env, evt, clan);
    ping = "dispatched";
  }

  return new Response(
    JSON.stringify(
      {
        ok: true,
        sig,
        type: evt.type || null,
        description: evt.description || null,
        side: swapSide(evt),
        feePayer: evt.feePayer || null,
        touched,
        watched,
        matched,
        wouldAlert:
          matched.length > 0 &&
          Boolean(evt.events?.swap || evt.type === "SWAP"),
        preview,
        ping,
      },
      null,
      2,
    ),
    { headers: { "Content-Type": "application/json" } },
  );
}

async function deleteTelegramWebhook(env) {
  const res = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/deleteWebhook`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ drop_pending_updates: false }),
    },
  );
  return res.json();
}

async function ensureTelegramPolling(env) {
  const row = await env.DB.prepare(
    "SELECT webhook_cleared FROM poll_state WHERE id = 1",
  ).first();
  if (row?.webhook_cleared) return;
  await deleteTelegramWebhook(env);
  await markWebhookCleared(env);
}

async function markWebhookCleared(env) {
  await env.DB.prepare(
    "UPDATE poll_state SET webhook_cleared = 1 WHERE id = 1",
  ).run();
}

// ---------------------------------------------------------------------
// Telegram command handling (via getUpdates polling)
// ---------------------------------------------------------------------
async function pollTelegram(env) {
  const state = await env.DB.prepare(
    "SELECT telegram_offset FROM poll_state WHERE id = 1",
  ).first();
  const offset = state?.telegram_offset ?? 0;

  const res = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getUpdates?offset=${offset}&timeout=0&allowed_updates=${encodeURIComponent(
      '["message"]',
    )}`,
  );
  const data = await res.json();
  if (!data.ok) {
    console.error("Telegram getUpdates failed:", data);
    return;
  }

  for (const update of data.result) {
    if (update.message) {
      await processTelegramMessage(env, update.message);
    }
    await env.DB.prepare(
      "UPDATE poll_state SET telegram_offset = ? WHERE id = 1",
    )
      .bind(update.update_id + 1)
      .run();
  }
}

async function processTelegramMessage(env, message) {
  if (!message.text) return;

  const chatId = String(message.chat.id);
  const text = message.text.trim();
  const [cmdRaw, ...args] = text.split(/\s+/);
  const cmd = cmdRaw.toLowerCase().replace(/@\w+$/, "");

  switch (cmd) {
    case "/start":
    case "/help":
      await sendTelegram(
        env,
        chatId,
        "Clan alert bot.\n" +
          "/test — sample swap ping\n" +
          "/test-thesis — sample thesis ping\n" +
          "/list — clan members we're alerting on\n" +
          "/track <handle> — watch someone extra (not a clan member)\n" +
          "/untrack <handle> — drop an extra (clan members live in config.json)\n\n" +
          "Roster: config.json. Clan name + 24h PnL: FomoScan clan board.\n" +
          "Swaps: Helius. Theses: FomoScan, every minute.",
      );
      break;

    case "/test":
      await sendTestAlert(env);
      break;

    case "/track":
      await cmdTrack(env, chatId, args[0]);
      break;

    case "/untrack":
      await cmdUntrack(env, chatId, args[0]);
      break;

    case "/list":
      await cmdList(env, chatId);
      break;

    default:
      break;
  }
}

async function cmdTrack(env, chatId, handle) {
  if (!handle) {
    return sendTelegram(env, chatId, "Usage: /track <fomo.family handle>");
  }

  const result = await upsertTrackedHandle(env, handle);
  if (result.status === "exists") {
    return sendTelegram(env, chatId, `Already tracking @${result.handle}.`);
  }
  if (result.status === "error") {
    return sendTelegram(
      env,
      chatId,
      `Could not track "${handle}": ${result.reason}.`,
    );
  }

  await syncHeliusWebhook(env);
  return sendTelegram(
    env,
    chatId,
    `Extra watch on @${result.handle} (${result.persona.name ?? "no name"})\nSolana: ${short(result.persona.solanaAddress)}\nThis is not a clan-member alert unless you add them to config.json.`,
  );
}

async function cmdUntrack(env, chatId, handle) {
  if (!handle) {
    return sendTelegram(env, chatId, "Usage: /untrack <fomo.family handle>");
  }
  handle = normalizeHandle(handle);

  if (configHandleSet().has(handle)) {
    return sendTelegram(
      env,
      chatId,
      `@${handle} is in config.json — remove it there and redeploy, or it will come back on the next poll.`,
    );
  }

  const row = await env.DB.prepare(
    "SELECT handle FROM personas WHERE handle = ?",
  )
    .bind(handle)
    .first();
  if (!row) {
    return sendTelegram(env, chatId, `Not currently tracking @${handle}.`);
  }

  await env.DB.prepare("DELETE FROM personas WHERE handle = ?")
    .bind(handle)
    .run();
  await syncHeliusWebhook(env);
  return sendTelegram(env, chatId, `Stopped tracking @${handle}.`);
}

async function cmdList(env, chatId) {
  const { results } = await env.DB.prepare(
    "SELECT handle, solana_address FROM personas ORDER BY created_at DESC",
  ).all();
  const fromConfig = configHandleSet();

  if (!results.length) {
    return sendTelegram(
      env,
      chatId,
      "No clan members loaded yet. Add fomo handles to config.json and redeploy.",
    );
  }

  const clan = await fetchClanSnapshot(env);
  const lines = results.map((r) => {
    const tag = fromConfig.has(normalizeHandle(r.handle)) ? "clan" : "extra";
    return `@${r.handle} — ${short(r.solana_address)} (${tag})`;
  });
  return sendTelegram(
    env,
    chatId,
    `${clanHeadline(clan)}\n\n${results.length} wallet(s):\n${lines.join("\n")}`,
  );
}

// ---------------------------------------------------------------------
// FomoScan — handle -> wallet resolution
// ---------------------------------------------------------------------
async function fomoscanGetHandle(env, handle) {
  const res = await fetch(
    `${FOMOSCAN_BASE}/user/handle/${encodeURIComponent(handle)}`,
    {
      headers: fomoscanHeaders(env),
    },
  );
  if (!res.ok) {
    const err = new Error(`FomoScan ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// ---------------------------------------------------------------------
// Helius webhook — live SWAP events on tracked wallets
// ---------------------------------------------------------------------
async function getTrackedAddresses(env) {
  const { results } = await env.DB.prepare(
    "SELECT solana_address FROM personas WHERE solana_address IS NOT NULL",
  ).all();
  return [...new Set(results.map((r) => r.solana_address).filter(Boolean))];
}

async function getHeliusWebhookId(env) {
  const row = await env.DB.prepare(
    "SELECT helius_webhook_id FROM poll_state WHERE id = 1",
  ).first();
  return row?.helius_webhook_id ?? null;
}

async function setHeliusWebhookId(env, id) {
  await env.DB.prepare(
    "UPDATE poll_state SET helius_webhook_id = ? WHERE id = 1",
  )
    .bind(id)
    .run();
}

async function syncHeliusWebhook(env, request) {
  if (!env.HELIUS_API_KEY) {
    return { ok: false, error: "HELIUS_API_KEY missing" };
  }

  const accountAddresses = await getTrackedAddresses(env);
  const webhookURL = workerWebhookUrl(env, request);
  const body = {
    webhookURL,
    // DFlow aggregator trades are often UNKNOWN, not SWAP.
    transactionTypes: ["Any"],
    accountAddresses,
    webhookType: "enhanced",
    txnStatus: "success",
  };
  if (env.HELIUS_WEBHOOK_SECRET) body.authHeader = env.HELIUS_WEBHOOK_SECRET;

  const webhookId = await getHeliusWebhookId(env);
  const url = webhookId
    ? `${HELIUS_API_BASE}/webhooks/${webhookId}?api-key=${env.HELIUS_API_KEY}`
    : `${HELIUS_API_BASE}/webhooks?api-key=${env.HELIUS_API_KEY}`;
  const method = webhookId ? "PUT" : "POST";

  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text();
    console.error("Helius webhook upsert failed:", res.status, detail);
    return {
      ok: false,
      status: res.status,
      detail,
      webhookURL,
      accountAddresses,
    };
  }

  if (!webhookId) {
    const created = await res.json();
    const id = created.webhookID || created.webhookId || created.id;
    if (id) await setHeliusWebhookId(env, id);
    return { ok: true, webhookID: id, webhookURL, accountAddresses };
  }

  return { ok: true, webhookID: webhookId, webhookURL, accountAddresses };
}

async function handleHeliusWebhook(request, env) {
  if (env.HELIUS_WEBHOOK_SECRET) {
    const auth =
      request.headers.get("Authorization") ||
      request.headers.get("authorization");
    if (auth !== env.HELIUS_WEBHOOK_SECRET) {
      return new Response("unauthorized", { status: 401 });
    }
  }

  const payload = await request.json();
  const events = heliusEvents(payload);
  let clan = { found: false };
  try {
    clan = (await fetchClanSnapshot(env)) || clan;
  } catch (err) {
    console.error("clan snapshot failed", err);
  }

  const notes = [];
  for (const raw of events) {
    const sig = txSignature(raw);
    const type = raw?.type || null;
    try {
      const evt = await toEnhancedSwap(env, raw);
      if (!evt) {
        notes.push({
          skipped: true,
          reason: "not_a_swap",
          type,
          signature: sig,
          feePayer: raw?.feePayer || null,
          tokenTransfers: raw?.tokenTransfers?.length || 0,
          hasSwapEvent: Boolean(raw?.events?.swap),
        });
        continue;
      }
      const dispatched = await dispatchSwapAlert(env, evt, clan);
      notes.push({
        skipped: dispatched.alerts === 0,
        reason: dispatched.reason || "alerted",
        alerts: dispatched.alerts,
        type: evt.type || type,
        signature: txSignature(evt) || sig,
        side: swapSide(evt),
        matched: dispatched.matched || [],
      });
    } catch (err) {
      console.error("swap event failed", sig, err);
      notes.push({
        skipped: true,
        reason: err?.message || "error",
        signature: sig,
        type,
      });
    }
  }

  console.log("helius-webhook", { count: events.length, notes });
  await rememberWebhook(env, { count: events.length, notes });

  return new Response(
    JSON.stringify({ ok: true, count: events.length, notes }),
    {
      headers: { "Content-Type": "application/json" },
    },
  );
}

async function rememberWebhook(env, note) {
  try {
    await env.DB.prepare(
      "UPDATE poll_state SET last_webhook_at = ?, last_webhook_note = ? WHERE id = 1",
    )
      .bind(new Date().toISOString(), JSON.stringify(note).slice(0, 4000))
      .run();
  } catch (err) {
    console.error("rememberWebhook skipped", err?.message || err);
  }
}

async function toEnhancedSwap(env, evt) {
  const local = asSwapEvent(evt);
  if (swapFocus(local)?.token?.mint) return local;

  const sig = txSignature(evt);
  if (!sig || !env.HELIUS_API_KEY) return local;

  const parsed = asSwapEvent(await parseHeliusTx(env, sig));
  if (swapFocus(parsed)?.token?.mint) return parsed;
  return parsed || local;
}

async function parseHeliusTx(env, sig) {
  if (!sig || !env.HELIUS_API_KEY) return null;

  const enhanced = await parseEnhancedTx(env, sig);
  if (
    enhanced &&
    !enhanced.__parseError &&
    (enhanced.events?.swap ||
      enhanced.type === "SWAP" ||
      enhanced.tokenTransfers?.length)
  ) {
    return enhanced;
  }

  const rpcPack = await fetchRpcTransaction(env, sig);
  const rpc = rpcPack?.result ?? null;
  const fromRpc = rpcToEnhanced(rpc, sig);
  if (fromRpc) return fromRpc;
  return {
    __parseError: enhanced?.__parseError || "empty",
    __rpcHasResult: Boolean(rpc),
    __rpcError: rpcPack?.error || null,
    __pre: rpc?.meta?.preTokenBalances?.length ?? 0,
    __post: rpc?.meta?.postTokenBalances?.length ?? 0,
  };
}

async function parseEnhancedTx(env, sig) {
  const url = `${HELIUS_HISTORY_BASE}/transactions/?api-key=${env.HELIUS_API_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transactions: [sig] }),
  });
  if (!res.ok) {
    console.error("Helius parse failed:", res.status, await res.text());
    return { __parseError: res.status };
  }
  const parsed = await res.json();
  if (Array.isArray(parsed)) return parsed[0] || { __parseError: "empty" };
  if (parsed?.error) return { __parseError: parsed.error };
  return parsed;
}

async function fetchRpcTransaction(env, sig) {
  const endpoints = [
    `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`,
    "https://api.mainnet-beta.solana.com",
  ];
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "getTransaction",
    params: [
      sig,
      { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
    ],
  });

  let lastError = null;
  for (const url of endpoints) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      lastError = { status: res.status, body: json };
      continue;
    }
    if (json?.error) {
      lastError = json.error;
      continue;
    }
    if (json?.result) return { result: json.result, error: null };
    lastError = { emptyResult: true, url };
  }
  return { result: null, error: lastError };
}

async function dispatchSwapAlert(env, evt, clan) {
  const sig = txSignature(evt);
  const touched = collectTouchedAccounts(evt);
  if (!touched.length)
    return { alerts: 0, reason: "no_touched_accounts", matched: [] };

  const placeholders = touched.map(() => "?").join(",");
  // last_signature is optional — older D1 schemas may not have the column yet.
  let results = [];
  try {
    ({ results } = await env.DB.prepare(
      `SELECT handle, chat_id, solana_address FROM personas WHERE solana_address IN (${placeholders})`,
    )
      .bind(...touched)
      .all());
  } catch (err) {
    console.error("persona lookup failed", err);
    return { alerts: 0, reason: `db: ${err.message}`, matched: [] };
  }

  if (!results.length) {
    return {
      alerts: 0,
      reason: "no_watched_wallet",
      matched: [],
      feePayer: evt.feePayer || null,
    };
  }

  let alerts = 0;
  const matched = [];
  for (const persona of results) {
    if (sig && persona.last_signature === sig) {
      matched.push({ handle: persona.handle, reason: "duplicate_sig" });
      continue;
    }
    await alertOnSwap(env, persona, evt, clan);
    alerts += 1;
    matched.push({ handle: persona.handle, reason: "alerted" });
    if (sig) {
      try {
        await env.DB.prepare(
          "UPDATE personas SET last_signature = ? WHERE handle = ?",
        )
          .bind(sig, persona.handle)
          .run();
      } catch (err) {
        console.error("last_signature update skipped", err);
      }
    }
  }

  return { alerts, reason: alerts ? "alerted" : "duplicate_sig", matched };
}

function swapFocusMint(evt) {
  return swapFocus(evt)?.token?.mint || null;
}

async function alertOnSwap(env, persona, evt, clan) {
  if (evt.type && evt.type !== "SWAP" && !evt.events?.swap) return;

  const dest = alertChatId(env) || persona.chat_id;
  let token = null;
  try {
    token = await fetchDexToken(swapFocusMint(evt));
  } catch (err) {
    console.error("token lookup failed", err);
  }
  const text = formatClanAlert({
    persona,
    evt,
    clan,
    isClanMember: configHandleSet().has(normalizeHandle(persona.handle)),
    token,
  });
  await sendTelegram(env, dest, text, { parseMode: "HTML" });
}

// ---------------------------------------------------------------------
// Telegram send helper
// ---------------------------------------------------------------------
async function sendTelegram(env, chatId, text, { parseMode } = {}) {
  if (!chatId) return { ok: false, error: "no chat id" };
  const body = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  };
  if (parseMode) body.parse_mode = parseMode;
  const res = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const raw = await res.text();
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    console.error("Telegram send non-JSON:", raw);
    return { ok: false, raw };
  }
  if (!json.ok) {
    console.error("Telegram send failed:", json);
  }
  return json;
}
