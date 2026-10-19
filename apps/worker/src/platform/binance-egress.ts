/**
 * 幣安 API 只能從這個 host 連線：`api.binance.com` 與 `api1`～`api4` 架在
 * CloudFront 後，會以 HTTP 403 拒絕 Cloudflare Workers 的出口 IP；GCP 版本不會。
 */
export const BINANCE_EGRESS_HOST = "api-gcp.binance.com";
const BINANCE_EGRESS_NAME = "binance";

// Cron 與 Queue consumer 常在美國機房執行，幣安對受限地區回應 HTTP 451。
// 固定名稱的物件只在首次建立時採用 locationHint，之後留在同一機房。
const BINANCE_EGRESS_LOCATION = "apac" as const;

const ALLOWED_METHODS = new Set(["GET", "POST"]);

export function isBinanceEgressUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === BINANCE_EGRESS_HOST &&
      url.port === "" &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

export async function proxyBinanceEgress(
  request: Request,
  outbound: (request: Request) => Promise<Response> = fetch,
): Promise<Response> {
  if (
    !ALLOWED_METHODS.has(request.method) ||
    !isBinanceEgressUrl(request.url)
  ) {
    return new Response(null, { status: 403 });
  }
  return outbound(request);
}

export function createBinanceEgressFetcher(
  namespace: DurableObjectNamespace,
): typeof fetch {
  const stub = namespace.getByName(BINANCE_EGRESS_NAME, {
    locationHint: BINANCE_EGRESS_LOCATION,
  });
  return (input, init) => stub.fetch(input, init);
}
