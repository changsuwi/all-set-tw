import { z } from "zod";
import { MAX_WALLET_ADDRESSES, parseAddressLines } from "../onchain-wallet";

const ETHEREUM_ADDRESS = /^0x[0-9a-f]{40}$/;

/** 以太坊地址比對不分大小寫；大小寫只是 EIP-55 檢查碼，統一轉小寫。 */
export function parseEthereumAddresses(value: string | undefined) {
  return [
    ...new Set(parseAddressLines(value).map((line) => line.toLowerCase())),
  ];
}

/** 以太坊錢包設定。地址只用於查詢鏈上公開資料，仍加密保存以免洩漏持倉。 */
export const ethereumConfigSchema = z.object({
  addresses: z
    .string()
    .max(4_000)
    .optional()
    .superRefine((value, context) => {
      const addresses = parseEthereumAddresses(value);
      if (addresses.length > MAX_WALLET_ADDRESSES) {
        context.addIssue({
          code: "custom",
          message: `最多可設定 ${MAX_WALLET_ADDRESSES} 個 ETH 地址。`,
        });
      }
      if (addresses.some((address) => !ETHEREUM_ADDRESS.test(address))) {
        context.addIssue({
          code: "custom",
          message: "ETH 地址格式不正確。",
        });
      }
    }),
});

export type EthereumConfig = z.infer<typeof ethereumConfigSchema>;

export function parseEthereumConfig(config: unknown): EthereumConfig {
  return ethereumConfigSchema.parse(config);
}
