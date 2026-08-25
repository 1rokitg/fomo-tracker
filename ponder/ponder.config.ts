import { createConfig } from "ponder";
import { clanEvmWallets } from "./src/wallets";

const wallets = clanEvmWallets();

function startBlock(name: string): number | undefined {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export default createConfig({
  chains: {
    ethereum: { id: 1, rpc: process.env.PONDER_RPC_URL_1 },
    base: { id: 8453, rpc: process.env.PONDER_RPC_URL_8453 },
    bsc: { id: 56, rpc: process.env.PONDER_RPC_URL_56 },
  },
  accounts: {
    ClanWallet: {
      address: wallets,
      chain: {
        ethereum: { startBlock: startBlock("PONDER_START_BLOCK_1") },
        base: { startBlock: startBlock("PONDER_START_BLOCK_8453") },
        bsc: { startBlock: startBlock("PONDER_START_BLOCK_56") },
      },
    },
  },
});
