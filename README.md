# fomo-tracker

Telegram bot that posts **clan swap alerts** for your fomo.family clan.

**Three data sources:**

- **FomoScan** resolves a handle to its verified Solana/EVM wallets (identity only — no trade feed).
- **Helius** enhanced webhook + cron address sync for Solana swaps.
- **Ponder** (`ponder/`) indexes the roster EVM wallets on Base, Ethereum, and BNB. The Worker pulls new swap rows from `PONDER_URL/graphql`.

Alerts are posted to the configured Telegram group (`TELEGRAM_CHAT_ID` in `wrangler.toml`) via Bot API `sendMessage`. That is outbound-only — the bot does not need a Telegram webhook.

Each alert is a **clan alert**: clan name, 24h rank, and combined 24h PnL come from FomoScan [`/v2/leaderboard/clans?window=24h`](https://api.fomoscan.sh/docs) (matched on `config.clanId`). Member @handles are not on that board, so the roster is still `config.json`.

EVM wallets on the roster are indexed by [Ponder](https://ponder.sh) (see `ponder/`). Set `PONDER_URL` on the Worker (the Ponder HTTP origin). First GraphQL poll stores a cursor and does not replay history. Optional: `POST /evm-webhook` with `{ "swaps": [ ...Ponder rows ] }` if you want Ponder to push.

## 1. Prerequisites

- Cloudflare account + `wrangler` CLI (`npm i -g wrangler`, then `wrangler login`)
- A Telegram bot: message [@BotFather](https://t.me/BotFather), `/newbot`, save the token
- Add the bot to the group you want alerts in (and give it permission to post)
- A free Helius API key: https://dev.helius.xyz
- The FomoScan key you were given

## 2. Install & create the D1 database

```bash
cd fomo-tracker
npm i
wrangler d1 create fomo-tracker
```

Copy the `database_id` it prints into `wrangler.toml`, then:

```bash
npm run db:init:remote
```

If the database already existed from an earlier schema:

```bash
npx wrangler d1 execute fomo-tracker --remote --file=./schema-migrate.sql
```

## 3. Set secrets

```bash
wrangler secret put FOMOSCAN_KEY
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put HELIUS_API_KEY
```

Set `PONDER_URL` in `wrangler.toml` `[vars]` (or as a Worker var) to your Ponder origin, e.g. `http://127.0.0.1:42069`.

Ponder itself needs RPC URLs in `ponder/.env` (`PONDER_RPC_URL_1`, `_8453`, `_56`) and start blocks so it does not backfill genesis.

Set `TELEGRAM_CHAT_ID` in `wrangler.toml` `[vars]` to the group id (e.g. `-1004446376533`).

## 4. Deploy

```bash
npm run deploy
```

Then visit `https://<your-worker-url>/setup` once. It deletes any leftover Telegram webhook (required so polling works) and posts a test message to the group.

## 5. Who to track

FomoScan's [`/v2/leaderboard/clans`](https://api.fomoscan.sh/docs) board is clan-level only (name, combined PnL, `memberCount`). It does **not** return member @handles, and there is no clan-members endpoint. Put the roster in `config.json` and redeploy:

```json
{
  "clanId": "e0767d97-696f-46aa-9db4-c5f10578691a",
  "handles": ["alice", "bob"]
}
```

Each cron tick resolves any new handles via FomoScan into D1. `/track` can add extras; `/untrack` cannot drop someone who is still in `config.json`.

```
/list
/track somehandle
/untrack somehandle
```

Commands are picked up on the next cron tick (up to ~1 minute). Swap alerts always go to the group in `TELEGRAM_CHAT_ID`. The first poll after a handle is added records a cursor and does not replay old swaps.

## 6. GitHub CI/CD

Pushes to `main` run tests, then deploy Worker `fomo-tracker` with Wrangler (`cloudflare/wrangler-action`).

1. Create a Cloudflare API token with **Edit Cloudflare Workers** ([token templates](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)).
2. In the GitHub repo: **Settings → Secrets and variables → Actions**, add:
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID` (`72265998f8cf66e3ab4d88575895dd0d` for the Pintosdsgn account)

Do not also connect **Workers Builds** on the same Worker unless you remove the deploy job — both would ship on every push. Runtime secrets (`FOMOSCAN_KEY`, `TELEGRAM_BOT_TOKEN`, `HELIUS_API_KEY`) stay in Cloudflare; `wrangler deploy` does not overwrite them.

## Notes

- Helius parsed transaction history: https://www.helius.dev/docs/enhanced-transactions/transaction-history
- FomoScan identity API: https://api.fomoscan.sh/docs
- Cron is `* * * * *` (every minute). Command replies and swap alerts can lag by up to one minute.
- The bot must remain in the group and be allowed to send messages.
