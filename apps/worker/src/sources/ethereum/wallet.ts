import type { WalletTransfer } from "../onchain-wallet";
import type {
  EthereumInternalTransaction,
  EthereumTransaction,
} from "./client";

function isOwn(
  ref: { hash: string } | null | undefined,
  ownAddresses: ReadonlySet<string>,
) {
  return Boolean(ref && ownAddresses.has(ref.hash.toLowerCase()));
}

/**
 * 一般交易對整組自有地址的淨變化（wei）。由自有地址送出時，gas 手續費一律由
 * 這組地址負擔；交易失敗時金額不會轉移，但手續費仍會扣除。
 */
export function ethereumTransfer(
  transaction: EthereumTransaction,
  ownAddresses: ReadonlySet<string>,
): WalletTransfer | null {
  const fromOwn = isOwn(transaction.from, ownAddresses);
  const toOwn = isOwn(transaction.to, ownAddresses);
  const succeeded = transaction.status !== "error";
  const value = succeeded ? BigInt(transaction.value) : 0n;
  const fee = fromOwn ? BigInt(transaction.fee?.value ?? "0") : 0n;
  const units = (toOwn ? value : 0n) - (fromOwn ? value + fee : 0n);
  if (units === 0n && fee === 0n) return null;

  const kind =
    units > 0n
      ? "receive"
      : fromOwn && toOwn
        ? "self"
        : value === 0n
          ? "fee"
          : "send";
  return {
    sourceId: transaction.hash,
    occurredAt: new Date(transaction.timestamp!).toISOString(),
    kind,
    units,
    feeUnits: fee,
    raw: {
      hash: transaction.hash,
      blockNumber: transaction.block_number,
      failed: !succeeded,
    },
  };
}

/**
 * 內部交易（合約轉帳）的淨變化。Blockscout 的 index 0 是交易本身的最上層呼叫，
 * 金額已由一般交易計入，略過以免重複；手續費也已在一般交易扣除。
 */
export function ethereumInternalTransfer(
  transaction: EthereumInternalTransaction,
  ownAddresses: ReadonlySet<string>,
): WalletTransfer | null {
  if (transaction.index === 0 || transaction.success === false) return null;
  const value = BigInt(transaction.value);
  const units =
    (isOwn(transaction.to, ownAddresses) ? value : 0n) -
    (isOwn(transaction.from, ownAddresses) ? value : 0n);
  if (units === 0n) return null;
  return {
    sourceId: `${transaction.transaction_hash}:internal:${transaction.index}`,
    occurredAt: new Date(transaction.timestamp!).toISOString(),
    kind: units > 0n ? "receive" : "send",
    units,
    feeUnits: 0n,
    raw: {
      hash: transaction.transaction_hash,
      internalIndex: transaction.index,
      blockNumber: transaction.block_number,
    },
  };
}
