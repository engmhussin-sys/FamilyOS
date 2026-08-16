/**
 * PHASE D (GROWTH) — ACQUISITION ATTRIBUTION.
 *
 * WHAT IS CAPTURED, AND THE ONE MOMENT IT CAN BE CAPTURED IN.
 *
 * Attribution is written EXACTLY ONCE, inside the registration transaction,
 * and never updated afterwards. Two reasons, and both of them are the same
 * reason expressed twice:
 *
 *   1. LAST-TOUCH ATTRIBUTION THAT CAN BE OVERWRITTEN IS NOT ATTRIBUTION. If a
 *      later request may rewrite `source`, then every campaign's number depends
 *      on which request arrived last, and a bug in the mobile app silently
 *      re-attributes a quarter of the funnel. The row is immutable by
 *      construction (`acquisition_attributions.family_id` is UNIQUE and the
 *      service only ever INSERTs).
 *   2. IT IS THE ONE MOMENT THE DATA EXISTS. Install referrer, UTM parameters
 *      and landing page live in the client's memory between the ad click and
 *      the first authenticated call. Nothing later can reconstruct them.
 *
 * THE CLIENT SUPPLIES THIS DATA AND THE CLIENT IS NOT TRUSTED. Every field is
 * normalised and length-capped here before it reaches the database, the channel
 * is resolved to a CLOSED vocabulary (an unknown source becomes `OTHER` and the
 * raw string is kept separately for diagnosis, never as a channel), and NONE of
 * it participates in any authorization decision. Attribution is a marketing
 * label attached to a row the server created; it can bias a chart and can do
 * nothing else. `family_id` still comes from the transaction that created the
 * family, never from the payload — CONTEXT §3 principle 3 is not relaxed here.
 */

/**
 * THE CLOSED CHANNEL VOCABULARY. Fourteen values, from the brief, and no
 * fifteenth without a migration and a review.
 *
 * A closed vocabulary is the difference between a channel report and a list of
 * typos: with a free-text column, `tiktok`, `TikTok`, `tik-tok` and `tt` are
 * four channels, and the fix always arrives after the quarter it was needed in.
 */
export const ACQUISITION_CHANNELS = [
  'ORGANIC',
  'TIKTOK',
  'INSTAGRAM',
  'FACEBOOK',
  'YOUTUBE',
  'GOOGLE',
  'INFLUENCER',
  'SCHOOL',
  'PARENT_COMMUNITY',
  'REFERRAL',
  'PARTNERSHIP',
  'APP_STORE',
  'GOOGLE_PLAY',
  'OTHER',
] as const;

export type AcquisitionChannel = (typeof ACQUISITION_CHANNELS)[number];

const CHANNEL_SET: ReadonlySet<string> = new Set(ACQUISITION_CHANNELS);

export function isAcquisitionChannel(value: string): value is AcquisitionChannel {
  return CHANNEL_SET.has(value);
}

/**
 * The mapping from the `utm_source` strings the world actually sends to the
 * fourteen channels above. Lower-cased comparison, longest match first is not
 * needed because every key is a whole token.
 *
 * Anything unmatched is `OTHER` — never a new channel invented at runtime.
 */
const SOURCE_TO_CHANNEL: ReadonlyMap<string, AcquisitionChannel> = new Map([
  ['tiktok', 'TIKTOK'],
  ['tiktokads', 'TIKTOK'],
  ['tt', 'TIKTOK'],
  ['instagram', 'INSTAGRAM'],
  ['ig', 'INSTAGRAM'],
  ['facebook', 'FACEBOOK'],
  ['fb', 'FACEBOOK'],
  ['meta', 'FACEBOOK'],
  ['youtube', 'YOUTUBE'],
  ['yt', 'YOUTUBE'],
  ['google', 'GOOGLE'],
  ['googleads', 'GOOGLE'],
  ['adwords', 'GOOGLE'],
  ['influencer', 'INFLUENCER'],
  ['school', 'SCHOOL'],
  ['schools', 'SCHOOL'],
  ['community', 'PARENT_COMMUNITY'],
  ['parentcommunity', 'PARENT_COMMUNITY'],
  ['referral', 'REFERRAL'],
  ['partner', 'PARTNERSHIP'],
  ['partnership', 'PARTNERSHIP'],
  ['appstore', 'APP_STORE'],
  ['ios', 'APP_STORE'],
  ['googleplay', 'GOOGLE_PLAY'],
  ['play', 'GOOGLE_PLAY'],
  ['android', 'GOOGLE_PLAY'],
  ['organic', 'ORGANIC'],
  ['direct', 'ORGANIC'],
  ['', 'ORGANIC'],
]);

/** The three client platforms that can register. */
export const ACQUISITION_PLATFORMS = ['ANDROID', 'IOS', 'WEB', 'UNKNOWN'] as const;
export type AcquisitionPlatform = (typeof ACQUISITION_PLATFORMS)[number];

const PLATFORM_SET: ReadonlySet<string> = new Set(ACQUISITION_PLATFORMS);

/** What the client may send. Every field optional — a direct install has none of it. */
export interface IAttributionInput {
  readonly source?: string;
  readonly campaign?: string;
  readonly medium?: string;
  readonly content?: string;
  readonly countryCode?: string;
  readonly platform?: string;
  readonly referralCode?: string;
  readonly referrer?: string;
  readonly landingPage?: string;
  /** The anonymous session the APP_INSTALLED event was emitted under. */
  readonly sessionId?: string;
}

/** What is actually stored. Normalised, capped, and with a resolved channel. */
export interface INormalisedAttribution {
  readonly channel: AcquisitionChannel;
  readonly source: string | null;
  readonly campaign: string | null;
  readonly medium: string | null;
  readonly content: string | null;
  readonly countryCode: string | null;
  readonly platform: AcquisitionPlatform;
  readonly referralCode: string | null;
  readonly referrer: string | null;
  readonly landingPage: string | null;
  readonly sessionId: string | null;
}

/** Column widths in migration 0015. Enforced here so a long UTM truncates rather than 500s. */
const MAX_LEN = {
  source: 120,
  campaign: 120,
  medium: 60,
  content: 120,
  referralCode: 32,
  referrer: 400,
  landingPage: 400,
  sessionId: 100,
} as const;

function clean(value: string | undefined, max: number): string | null {
  if (typeof value !== 'string') return null;
  // Control characters out first: a newline in a UTM parameter is either a
  // mistake or an attempt at log injection, and neither is a campaign name.
  // eslint-disable-next-line no-control-regex
  const trimmed = value.replace(/[\u0000-\u001F\u007F]/g, '').trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, max);
}

function normaliseCountry(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const upper = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(upper) ? upper : null;
}

function normalisePlatform(value: string | undefined): AcquisitionPlatform {
  if (typeof value !== 'string') return 'UNKNOWN';
  const upper = value.trim().toUpperCase();
  return PLATFORM_SET.has(upper) ? (upper as AcquisitionPlatform) : 'UNKNOWN';
}

/**
 * THE CHANNEL RESOLUTION, IN PRIORITY ORDER, and the order is the product
 * decision:
 *
 *   1. A REFERRAL CODE BEATS EVERYTHING. If parent B arrived with parent A's
 *      code, the channel is REFERRAL even if the click also carried a TikTok
 *      UTM — because the referral is what is about to cost us a reward, and the
 *      channel that gets charged must be the channel that gets credited.
 *   2. An explicit, recognised `source`.
 *   3. `medium` as a fallback for clients that send only `utm_medium`.
 *   4. `OTHER` when a source was sent but is not in the vocabulary — NOT
 *      `ORGANIC`. Filing unknown paid traffic as organic is how a channel
 *      report starts lying in the direction that flatters it.
 *   5. `ORGANIC` only when nothing at all was sent.
 */
export function resolveChannel(input: IAttributionInput): AcquisitionChannel {
  if (clean(input.referralCode, MAX_LEN.referralCode) !== null) return 'REFERRAL';

  const source = (input.source ?? '').trim().toLowerCase().replace(/[\s_-]/g, '');
  if (source.length > 0) {
    return SOURCE_TO_CHANNEL.get(source) ?? 'OTHER';
  }

  const medium = (input.medium ?? '').trim().toLowerCase().replace(/[\s_-]/g, '');
  if (medium.length > 0) {
    return SOURCE_TO_CHANNEL.get(medium) ?? 'OTHER';
  }

  return 'ORGANIC';
}

export function normaliseAttribution(input: IAttributionInput): INormalisedAttribution {
  return {
    channel: resolveChannel(input),
    source: clean(input.source, MAX_LEN.source),
    campaign: clean(input.campaign, MAX_LEN.campaign),
    medium: clean(input.medium, MAX_LEN.medium),
    content: clean(input.content, MAX_LEN.content),
    countryCode: normaliseCountry(input.countryCode),
    platform: normalisePlatform(input.platform),
    referralCode: clean(input.referralCode, MAX_LEN.referralCode)?.toUpperCase() ?? null,
    referrer: clean(input.referrer, MAX_LEN.referrer),
    landingPage: clean(input.landingPage, MAX_LEN.landingPage),
    sessionId: clean(input.sessionId, MAX_LEN.sessionId),
  };
}
