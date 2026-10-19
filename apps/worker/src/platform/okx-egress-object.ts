import { DurableObject } from "cloudflare:workers";
import { proxyOkxEgress } from "./okx-egress";

export class OkxEgress extends DurableObject {
  fetch(request: Request) {
    return proxyOkxEgress(request);
  }
}
