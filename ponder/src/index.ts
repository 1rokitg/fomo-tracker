import { ponder } from "ponder:registry";
import { swap } from "ponder:schema";
import { formatUnits, type Hex } from "viem";

const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as Hex;

const WRAPPED: Record<number, Hex> = {
  1: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
  8453: "0x4200000000000000000000000000000000000006",
  56: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
};

const STABLE_DECIMALS: Record<string, number> = {
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": 6,
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": 6,
  "0xdac17f958d2ee523a2206206994597c13d831ec7": 6,
  "0x55d398326f99059ff775485246999027b3197955": 18,
};

function topicAddress(topic: Hex | undefined): Hex | null {
  if (!topic || topic.length < 66) return null;
  return `0x${topic.slice(26).toLowerCase()}` as Hex;
}

function decimalsFor(token: string): number {
  return STABLE_DECIMALS[token.toLowerCase()] ?? 18;
}

async function indexWalletTx({
  event,
  context,
}: {
  event: {
    transaction: { hash: Hex; from: Hex; to?: Hex | null; value: bigint };
    block: { timestamp: bigint; number: bigint };
  };
  context: {
    chain: { id: number };
    client: { getTransactionReceipt: (args: { hash: Hex }) => Promise<{ status?: string; logs?: any[] }> };
    db: { insert: Function };
  };
}) {
  const chainId = context.chain.id;
  const hash = event.transaction.hash;
  const wallet = event.transaction.from.toLowerCase() as Hex;
  const id = `${chainId}:${hash}`;

  let logs: { topics: Hex[]; data: Hex; address: Hex }[] = [];
  try {
    const receipt = await context.client.getTransactionReceipt({ hash });
    if (receipt?.status && receipt.status !== "success") return;
    logs = receipt?.logs || [];
  } catch {
    return;
  }

  const tokenInputs: { mint: Hex; tokenAmount: string }[] = [];
  const tokenOutputs: { mint: Hex; tokenAmount: string }[] = [];

  for (const log of logs) {
    if ((log.topics?.[0] || "").toLowerCase() !== TRANSFER_TOPIC) continue;
    if ((log.topics?.length || 0) < 3) continue;
    const from = topicAddress(log.topics[1]);
    const to = topicAddress(log.topics[2]);
    if (!from || !to) continue;
    if (from !== wallet && to !== wallet) continue;
    const raw = BigInt(log.data || "0x0");
    if (raw === 0n) continue;
    const mint = log.address.toLowerCase() as Hex;
    const amount = formatUnits(raw, decimalsFor(mint));
    if (from === wallet) tokenInputs.push({ mint, tokenAmount: amount });
    if (to === wallet) tokenOutputs.push({ mint, tokenAmount: amount });
  }

  if (event.transaction.value > 0n) {
    const wrapped = WRAPPED[chainId];
    if (wrapped) {
      tokenInputs.push({
        mint: wrapped,
        tokenAmount: formatUnits(event.transaction.value, 18),
      });
    }
  }

  if (!tokenInputs.length || !tokenOutputs.length) return;

  const tokenIn = tokenInputs.sort((a, b) => Number(b.tokenAmount) - Number(a.tokenAmount))[0];
  const tokenOut = tokenOutputs.sort((a, b) => Number(b.tokenAmount) - Number(a.tokenAmount))[0];
  if (tokenIn.mint === tokenOut.mint) return;

  await context.db
    .insert(swap)
    .values({
      id,
      chainId,
      hash,
      wallet,
      timestamp: event.block.timestamp,
      blockNumber: event.block.number,
      tokenIn: tokenIn.mint,
      tokenInAmount: tokenIn.tokenAmount,
      tokenOut: tokenOut.mint,
      tokenOutAmount: tokenOut.tokenAmount,
    })
    .onConflictDoNothing();
}

ponder.on("ClanWallet:transaction:from", indexWalletTx);
