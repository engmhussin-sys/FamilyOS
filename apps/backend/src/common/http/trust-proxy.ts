import type { NestExpressApplication } from '@nestjs/platform-express';

/**
 * SA-004, half one. Express defaults `trust proxy` to false, which makes
 * `req.ip` the address of the nearest peer — in every deployment this
 * project targets (Railway, and any container behind a load balancer)
 * that peer is the reverse proxy, identical for every client on earth.
 * `ThrottlerGuard` derives its bucket key from `req.ips[0] ?? req.ip`, so
 * with the default the entire internet shares ONE bucket: a single
 * attacker consumes everyone's budget, and no per-attacker limit exists
 * at all. All 27 `@Throttle` decorators in this codebase are inert until
 * this is set.
 *
 * The value is a HOP COUNT, deliberately not `true`. `true` trusts the
 * whole `X-Forwarded-For` chain, so any client can prepend a forged
 * address and mint itself an unlimited number of fresh rate-limit
 * buckets. `1` trusts exactly the single proxy in front of us and takes
 * the last entry that proxy appended, which is the real client address.
 * Change this number only when the number of proxies in front of the app
 * actually changes.
 */
export const TRUSTED_PROXY_HOP_COUNT = 1;

export function configureTrustProxy(
  app: Pick<NestExpressApplication, 'set'>,
  hops: number = TRUSTED_PROXY_HOP_COUNT,
): void {
  app.set('trust proxy', hops);
}
