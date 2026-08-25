import { index, onchainTable } from "ponder";

/** One row per wallet swap Ponder extracts from a clan member tx. */
export const swap = onchainTable(
  "swap",
  (t) => ({
    id: t.text().primaryKey(),
    chainId: t.integer().notNull(),
    hash: t.hex().notNull(),
    wallet: t.hex().notNull(),
    timestamp: t.bigint().notNull(),
    blockNumber: t.bigint().notNull(),
    tokenIn: t.hex(),
    tokenInAmount: t.text(),
    tokenOut: t.hex(),
    tokenOutAmount: t.text(),
  }),
  (table) => ({
    walletIdx: index().on(table.wallet),
    tsIdx: index().on(table.timestamp),
  }),
);
