import * as crypto from 'crypto';

/**
 * PHASE D — APPLE JWS VERIFICATION, DONE PROPERLY.
 *
 * ============================ WHAT THIS IS ============================
 *
 * Apple signs every transaction, every renewal-info blob and every App Store
 * Server Notification V2 as a JWS. The signature is ES256 and the signing key
 * is presented IN THE HEADER, as an `x5c` certificate chain. Apple's own
 * documentation (`JWSDecodedHeader`, App Store Server API) states the chain
 * order verbatim:
 *
 *   1. «A certificate that contains the public key that corresponds to the key
 *      the App Store uses to digitally sign the JWS.»
 *   2. «An Apple intermediate certificate that contains an extension with the
 *      extension ID for Apple Worldwide Developer Relations
 *      (1.2.840.113635.100.6.2.1).»
 *   3. «An Apple root certificate.»
 *
 *   -- https://developer.apple.com/documentation/appstoreserverapi/jwsdecodedheader
 *      (fetched 2026-08-16)
 *
 * Verification therefore means FOUR things, and skipping any one of them makes
 * the other three worthless:
 *
 *   (a) the leaf certificate's public key actually signed this JWS;
 *   (b) the leaf was issued by the intermediate, and the intermediate by the
 *       root — checked by signature, not by name;
 *   (c) the ROOT IS APPLE'S, pinned by SHA-256 fingerprint. Without this step
 *       an attacker simply ships their own three-certificate chain in the
 *       header and signs whatever they like. This is the single most commonly
 *       skipped step in the wild, and it turns "verified" into decoration;
 *   (d) every certificate in the chain is inside its validity window.
 *
 * ======================= WHAT IS NOT DONE HERE ========================
 *
 * OCSP / CRL revocation checking is NOT performed. Apple's own
 * `app-store-server-library` performs it optionally and online; doing it
 * synchronously inside a webhook handler would make our 200 OK depend on
 * Apple's OCSP responder being up, and a webhook that times out is a webhook
 * that gets redelivered forever. Documented as an accepted risk in
 * `PHASE-D-Payments-Report.md` §«افتراضات ومخاطر مفتوحة», not silently omitted.
 *
 * ============ WHY THIS IS HAND-ROLLED AND NOT A LIBRARY ==============
 *
 * `@apple/app-store-server-library` exists and would be the right dependency
 * in a networked environment. This environment cannot install new npm packages
 * (the same registry blocker every prior phase documented), and Node 22's
 * `crypto.X509Certificate` + `crypto.verify` cover exactly the four checks
 * above with no dependency at all. When the client's CI has a registry, moving
 * to Apple's library is a drop-in replacement for THIS FILE ONLY — nothing
 * outside it knows how a signature is checked.
 *
 * ================== THE ROOT CERTIFICATE FINGERPRINT ==================
 *
 * `APPLE_ROOT_CA_G3_SHA256` is a configuration value, not a secret, and it is
 * NOT hardcoded from memory: it is read from `APPLE_ROOT_CA_G3_FINGERPRINT`
 * with no default. The operator obtains it once, from Apple PKI
 * (https://www.apple.com/certificateauthority/), by running:
 *
 *   openssl x509 -in AppleRootCA-G3.cer -inform DER -noout -fingerprint -sha256
 *
 * WHY NO DEFAULT: a wrong pinned fingerprint written from memory is worse than
 * no pin — it fails closed in production for a reason nobody can debug, or (if
 * mistyped in the other direction) it silently matches nothing and someone
 * "fixes" it by removing the check. Unconfigured, this verifier REFUSES every
 * signature and says exactly why. See `.env.example`.
 */

export interface IJwsVerificationResult<T> {
  readonly verified: boolean;
  readonly payload: T | null;
  readonly reason: string | null;
  /** SHA-256 of the exact JWS string that was verified. */
  readonly digest: string;
}

/** Apple's WWDR intermediate carries this extension OID. */
const APPLE_WWDR_EXTENSION_OID = '1.2.840.113635.100.6.2.1';

export interface IAppleJwsVerifierOptions {
  /**
   * Uppercase, colon-separated SHA-256 fingerprint of Apple Root CA G3, as
   * `openssl -fingerprint -sha256` prints it. Case and colons are normalised
   * before comparison so either style works.
   */
  readonly rootFingerprintSha256: string | null;
  /** Injectable for tests. Defaults to `() => new Date()`. */
  readonly now?: () => Date;
}

export class AppleJwsVerifier {
  private readonly normalisedRootFingerprint: string | null;
  private readonly now: () => Date;

  constructor(options: IAppleJwsVerifierOptions) {
    this.normalisedRootFingerprint = options.rootFingerprintSha256
      ? normaliseFingerprint(options.rootFingerprintSha256)
      : null;
    this.now = options.now ?? (() => new Date());
  }

  isConfigured(): boolean {
    return this.normalisedRootFingerprint !== null;
  }

  /**
   * Verifies a compact JWS and returns its decoded payload.
   *
   * FAILS CLOSED at every step. There is no branch in this method that returns
   * `verified: true` without having checked the signature against a chain that
   * terminates at the pinned Apple root.
   */
  verify<T>(jws: string): IJwsVerificationResult<T> {
    const digest = sha256Hex(jws);
    const fail = (reason: string): IJwsVerificationResult<T> => ({
      verified: false,
      payload: null,
      reason,
      digest,
    });

    if (!this.normalisedRootFingerprint) {
      return fail(
        'APPLE_ROOT_CA_G3_FINGERPRINT is not configured. Apple JWS verification is refused rather than skipped.',
      );
    }

    const parts = jws.split('.');
    if (parts.length !== 3) return fail(`Malformed JWS: expected 3 dot-separated parts, got ${parts.length}.`);
    const [encodedHeader, encodedPayload, encodedSignature] = parts;

    let header: { alg?: string; x5c?: string[] };
    try {
      header = JSON.parse(base64UrlDecode(encodedHeader).toString('utf8')) as { alg?: string; x5c?: string[] };
    } catch {
      return fail('JWS header is not valid base64url-encoded JSON.');
    }

    // ES256 ONLY. `alg: "none"` and an HMAC downgrade (`alg: "HS256"` with the
    // certificate bytes as the key) are the two classic JWT attacks; both are
    // refused here by construction rather than by hoping the library is sane.
    if (header.alg !== 'ES256') {
      return fail(`Unsupported JWS alg "${header.alg}". Apple signs with ES256; nothing else is accepted.`);
    }
    if (!Array.isArray(header.x5c) || header.x5c.length < 3) {
      return fail(
        `JWS header x5c must be a chain of at least 3 certificates (leaf, Apple intermediate, Apple root); got ${
          Array.isArray(header.x5c) ? header.x5c.length : 'none'
        }.`,
      );
    }

    let chain: crypto.X509Certificate[];
    try {
      chain = header.x5c.map((der) => new crypto.X509Certificate(Buffer.from(der, 'base64')));
    } catch (error) {
      return fail(`JWS header x5c contains a certificate that could not be parsed: ${describe(error)}`);
    }

    const chainCheck = this.verifyChain(chain);
    if (chainCheck) return fail(chainCheck);

    // (a) THE SIGNATURE ITSELF, against the leaf's public key.
    //
    // `dsaEncoding: 'ieee-p1363'` is load-bearing and is the single most common
    // way this is written wrong: a JWS ES256 signature is the raw 64-byte
    // r||s concatenation (RFC 7515 §3.4), NOT the DER-wrapped SEQUENCE that
    // Node's crypto defaults to. Without this option every genuine Apple
    // signature is rejected, and the usual "fix" is to stop verifying.
    let signatureValid: boolean;
    try {
      signatureValid = crypto.verify(
        'sha256',
        Buffer.from(`${encodedHeader}.${encodedPayload}`, 'ascii'),
        { key: chain[0].publicKey, dsaEncoding: 'ieee-p1363' },
        base64UrlDecode(encodedSignature),
      );
    } catch (error) {
      return fail(`Signature verification threw: ${describe(error)}`);
    }
    if (!signatureValid) return fail('JWS signature does not verify against the leaf certificate public key.');

    let payload: T;
    try {
      payload = JSON.parse(base64UrlDecode(encodedPayload).toString('utf8')) as T;
    } catch {
      return fail('JWS payload is not valid base64url-encoded JSON.');
    }

    return { verified: true, payload, reason: null, digest };
  }

  /** Returns a failure reason, or null when the chain is good. */
  private verifyChain(chain: crypto.X509Certificate[]): string | null {
    const now = this.now();

    // (d) VALIDITY WINDOWS, every certificate, before anything else.
    for (let i = 0; i < chain.length; i += 1) {
      const cert = chain[i];
      const notBefore = new Date(cert.validFrom);
      const notAfter = new Date(cert.validTo);
      if (now < notBefore || now > notAfter) {
        return `Certificate ${i} in the x5c chain is outside its validity window (${cert.validFrom} .. ${cert.validTo}).`;
      }
    }

    // (b) EACH LINK, BY SIGNATURE. `cert.verify(key)` asks "was this
    // certificate signed by this key", which is the question that matters.
    // Comparing issuer/subject STRINGS instead — which is what a surprising
    // amount of published sample code does — proves nothing at all: an
    // attacker can put any string in a certificate they generate themselves.
    for (let i = 0; i < chain.length - 1; i += 1) {
      let issued: boolean;
      try {
        issued = chain[i].verify(chain[i + 1].publicKey);
      } catch (error) {
        return `Certificate ${i} could not be checked against its issuer: ${describe(error)}`;
      }
      if (!issued) {
        return `Certificate ${i} in the x5c chain was not issued by certificate ${i + 1}.`;
      }
    }

    // Apple documents the middle certificate as carrying the WWDR extension
    // OID. Checked because it is cheap and it catches a chain that verifies
    // structurally but is not the chain Apple describes.
    const intermediate = chain[chain.length - 2];
    if (!certificateHasExtension(intermediate, APPLE_WWDR_EXTENSION_OID)) {
      return `The intermediate certificate does not carry the Apple WWDR extension OID ${APPLE_WWDR_EXTENSION_OID}.`;
    }

    // (c) THE PIN. Everything above is satisfiable by an attacker who
    // generates their own three-certificate chain. This step is what makes the
    // chain Apple's.
    const root = chain[chain.length - 1];
    const rootFingerprint = normaliseFingerprint(root.fingerprint256);
    if (rootFingerprint !== this.normalisedRootFingerprint) {
      return 'The x5c chain does not terminate at the pinned Apple root certificate.';
    }

    // A root certificate is self-signed. Verifying it against its own key
    // closes the last gap: a chain whose final certificate merely CLAIMS the
    // pinned fingerprint but is not internally consistent is refused.
    try {
      if (!root.verify(root.publicKey)) {
        return 'The pinned root certificate is not self-signed and is therefore not a root.';
      }
    } catch (error) {
      return `The pinned root certificate could not be self-verified: ${describe(error)}`;
    }

    return null;
  }
}

/**
 * Decodes a JWS payload WITHOUT verifying it.
 *
 * Exists for exactly one legitimate purpose: reading `notificationUUID` from an
 * App Store Server Notification so the DEDUPE ROW can be written before
 * anything else happens. The dedupe row records `signature_verified = false`
 * until verification succeeds, and no entitlement is ever derived from a value
 * obtained through this function. Named to make misuse obvious in review.
 */
export function unsafeDecodeJwsPayload<T>(jws: string): T | null {
  const parts = jws.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(base64UrlDecode(parts[1]).toString('utf8')) as T;
  } catch {
    return null;
  }
}

export function base64UrlDecode(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export function base64UrlEncode(value: Buffer | string): string {
  return (typeof value === 'string' ? Buffer.from(value, 'utf8') : value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function normaliseFingerprint(value: string): string {
  return value.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
}

function certificateHasExtension(cert: crypto.X509Certificate, oid: string): boolean {
  // Node does not expose an extension list, so the check is done on the PEM's
  // textual form via the raw DER: the OID's DER encoding is searched for in the
  // certificate bytes. Narrow, but exact — an OID's DER encoding is unique.
  const der = cert.raw;
  const encoded = encodeOid(oid);
  return der.includes(encoded);
}

/** Minimal DER OID encoder. Enough for the fixed OID above. */
function encodeOid(oid: string): Buffer {
  const parts = oid.split('.').map((p) => Number.parseInt(p, 10));
  const body: number[] = [parts[0] * 40 + parts[1]];
  for (const part of parts.slice(2)) {
    const chunks: number[] = [];
    let value = part;
    do {
      chunks.unshift(value & 0x7f);
      value >>>= 7;
    } while (value > 0);
    for (let i = 0; i < chunks.length - 1; i += 1) chunks[i] |= 0x80;
    body.push(...chunks);
  }
  return Buffer.from([0x06, body.length, ...body]);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
