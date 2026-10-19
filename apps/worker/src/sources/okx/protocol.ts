import { z } from "zod";

/** OKX API key 為 UUID；secret 為 32 位十六進位；passphrase 由使用者建立時自訂。 */
const OKX_API_KEY =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OKX_API_SECRET = /^[0-9A-F]{32}$/i;

function patternField(pattern: RegExp, message: string) {
  return z
    .string()
    .trim()
    .optional()
    .superRefine((value, context) => {
      if (value !== undefined && !pattern.test(value)) {
        context.addIssue({ code: "custom", message });
      }
    });
}

/** OKX 設定。API key 只需讀取權限；三者都加密保存，不寫入 log 或 raw。 */
export const okxConfigSchema = z.object({
  apiKey: patternField(OKX_API_KEY, "OKX API Key 格式不正確。"),
  apiSecret: patternField(OKX_API_SECRET, "OKX Secret Key 格式不正確。"),
  passphrase: z.string().min(1).max(64).optional(),
});

export type OkxConfig = z.infer<typeof okxConfigSchema>;

export function parseOkxConfig(config: unknown): OkxConfig {
  return okxConfigSchema.parse(config);
}
