import type { WalletTransfer } from "../onchain-wallet";
import type { BitcoinTransaction } from "./client";

/**
 * 計算一筆交易對整組自有地址的淨變化（satoshi）。輸入來自自有地址代表由這組
 * 地址付款，手續費也由這組地址負擔；輸出全部回到自有地址時視為自有地址互轉。
 * 淨變化為 0 的交易（例如只經過、未影響餘額）不產生紀錄。
 */
export function bitcoinTransfer(
  transaction: BitcoinTransaction,
  ownAddresses: ReadonlySet<string>,
): WalletTransfer | null {
  let received = 0n;
  let externalOutput = 0n;
  for (const output of transaction.vout) {
    if (
      output.scriptpubkey_address &&
      ownAddresses.has(output.scriptpubkey_address)
    ) {
      received += BigInt(output.value);
    } else {
      externalOutput += BigInt(output.value);
    }
  }
  let spent = 0n;
  for (const input of transaction.vin) {
    const address = input.prevout?.scriptpubkey_address;
    if (address && ownAddresses.has(address)) {
      spent += BigInt(input.prevout!.value);
    }
  }

  const units = received - spent;
  const paidByOwnAddresses = spent > 0n;
  if (units === 0n && !paidByOwnAddresses) return null;

  const kind =
    units > 0n
      ? "receive"
      : paidByOwnAddresses && externalOutput === 0n
        ? "self"
        : "send";
  return {
    sourceId: transaction.txid,
    occurredAt: new Date(transaction.status.block_time! * 1000).toISOString(),
    kind,
    units,
    feeUnits: paidByOwnAddresses ? BigInt(transaction.fee) : 0n,
    raw: {
      txid: transaction.txid,
      blockHeight: transaction.status.block_height,
    },
  };
}
