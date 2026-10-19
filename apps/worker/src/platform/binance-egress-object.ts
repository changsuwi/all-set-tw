import { DurableObject } from "cloudflare:workers";
import { proxyBinanceEgress } from "./binance-egress";

export class BinanceEgress extends DurableObject {
  fetch(request: Request) {
    return proxyBinanceEgress(request);
  }
}
