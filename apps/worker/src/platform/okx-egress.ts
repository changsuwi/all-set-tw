/**
 * OKX 依註冊地區分站，API key 只能在建立它的站使用；同步依序嘗試這些 host。
 * 第一個是全球站（台灣註冊的帳號）。
 */
export const OKX_API_HOSTS = [
  "www.okx.com",
  "my.okx.com",
  "eea.okx.com",
] as const;
export type OkxApiHost = (typeof OKX_API_HOSTS)[number];

const OKX_EGRESS_NAME = "okx";

// 公開端點從各機房都能連線，但帶簽章的帳戶端點在美國機房是否受合規限制
// 無法事先確認；Cron 與 Queue consumer 常在美國執行，因此固定由亞太機房送出。
// 固定名稱的物件只在首次建立時採用 locationHint，之後留在同一機房。
const OKX_EGRESS_LOCATION = "apac" as const;

const ALLOWED_METHODS = new Set(["GET"]);

export function isOkxEgressUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (OKX_API_HOSTS as readonly string[]).includes(url.hostname) &&
      url.port === "" &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

export async function proxyOkxEgress(
  request: Request,
  outbound: (request: Request) => Promise<Response> = fetch,
): Promise<Response> {
  if (!ALLOWED_METHODS.has(request.method) || !isOkxEgressUrl(request.url)) {
    return new Response(null, { status: 403 });
  }
  return outbound(request);
}

export function createOkxEgressFetcher(
  namespace: DurableObjectNamespace,
): typeof fetch {
  const stub = namespace.getByName(OKX_EGRESS_NAME, {
    locationHint: OKX_EGRESS_LOCATION,
  });
  return (input, init) => stub.fetch(input, init);
}
