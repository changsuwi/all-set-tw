import { z } from "zod";

/** 幣安 HMAC API key 與 secret 都是 64 個英數字元；RSA／Ed25519 key 不支援。 */
const BINANCE_HMAC_KEY = /^[A-Za-z0-9]{64}$/;

function hmacKeyField(label: string) {
  return z
    .string()
    .trim()
    .optional()
    .superRefine((value, context) => {
      if (value !== undefined && !BINANCE_HMAC_KEY.test(value)) {
        context.addIssue({
          code: "custom",
          message: `幣安 ${label} 格式不正確，請使用系統產生（HMAC）的 API key。`,
        });
      }
    });
}

/** 幣安設定。API key 只需讀取權限；兩者都加密保存，不寫入 log 或 raw。 */
export const binanceConfigSchema = z.object({
  apiKey: hmacKeyField("API Key"),
  apiSecret: hmacKeyField("Secret Key"),
});

export type BinanceConfig = z.infer<typeof binanceConfigSchema>;

export function parseBinanceConfig(config: unknown): BinanceConfig {
  return binanceConfigSchema.parse(config);
}
