import { z } from "zod";
import { MAX_WALLET_ADDRESSES, parseAddressLines } from "../onchain-wallet";

const LEGACY_ADDRESS = /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/;
const SEGWIT_ADDRESS =
  /^(?:bc1q[ac-hj-np-z02-9]{38}|bc1q[ac-hj-np-z02-9]{58}|bc1p[ac-hj-np-z02-9]{58})$/;
const EXTENDED_PUBLIC_KEY = /^[xyz]pub/i;

/** Bech32 地址不分大小寫，統一轉小寫；舊式地址區分大小寫，維持原樣。 */
export function normalizeBitcoinAddress(address: string) {
  return /^bc1/i.test(address) ? address.toLowerCase() : address;
}

export function isBitcoinAddress(address: string) {
  return LEGACY_ADDRESS.test(address) || SEGWIT_ADDRESS.test(address);
}

export function parseBitcoinAddresses(value: string | undefined) {
  return [...new Set(parseAddressLines(value).map(normalizeBitcoinAddress))];
}

/** 比特幣錢包設定。地址只用於查詢鏈上公開資料，仍加密保存以免洩漏持倉。 */
export const bitcoinConfigSchema = z.object({
  addresses: z
    .string()
    .max(4_000)
    .optional()
    .superRefine((value, context) => {
      const addresses = parseBitcoinAddresses(value);
      if (addresses.length > MAX_WALLET_ADDRESSES) {
        context.addIssue({
          code: "custom",
          message: `最多可設定 ${MAX_WALLET_ADDRESSES} 個 BTC 地址。`,
        });
      }
      for (const address of addresses) {
        if (EXTENDED_PUBLIC_KEY.test(address)) {
          context.addIssue({
            code: "custom",
            message: "目前僅支援 BTC 地址，尚不支援 xpub／ypub／zpub。",
          });
        } else if (!isBitcoinAddress(address)) {
          context.addIssue({
            code: "custom",
            message: "BTC 地址格式不正確。",
          });
        }
      }
    }),
});

export type BitcoinConfig = z.infer<typeof bitcoinConfigSchema>;

export function parseBitcoinConfig(config: unknown): BitcoinConfig {
  return bitcoinConfigSchema.parse(config);
}
