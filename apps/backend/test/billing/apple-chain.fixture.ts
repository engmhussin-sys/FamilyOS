import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * PHASE D — A REAL THREE-CERTIFICATE ECDSA CHAIN, GENERATED LOCALLY.
 *
 * ================== WHY THIS EXISTS, AND WHAT IT IS NOT ==================
 *
 * The brief's rule for these tests is «mock the PROVIDER HTTP RESPONSES, never
 * the verification logic». This file is what makes that possible for Apple.
 *
 * `AppleJwsVerifier` is exercised AS WRITTEN — every certificate-chain check,
 * the ES256 signature check, the P1363 encoding, the root pin, the validity
 * windows. What is substituted is APPLE'S KEY MATERIAL, because we do not have
 * Apple's private key and never will. A locally generated chain
 * (leaf -> intermediate carrying the WWDR extension OID -> self-signed root)
 * is presented to the verifier, and the verifier is configured to pin THAT
 * root's fingerprint.
 *
 * So what these tests prove is: THE ALGORITHM IS CORRECT. Given a chain that
 * terminates at the pinned root, a genuine signature verifies and every kind of
 * forgery is refused. What they do NOT prove is interoperability with Apple's
 * real certificates, and no test in this repository claims otherwise — see
 * PHASE-D-Payments-Report.md, «ما هو BLOCKED».
 *
 * The negative controls are the important half. A test suite that only signs
 * correctly and asserts success would pass identically against a verifier that
 * returned `true` unconditionally. These fixtures therefore also produce:
 *
 *   - a SECOND, unrelated root, so a chain that verifies internally but is not
 *     the pinned one can be built (`buildForeignChainJws`);
 *   - `alg: "none"` and `alg: "HS256"` tampering (`buildAlgNoneJws`);
 *   - payload tampering after signing (`tamperPayload`).
 *
 * Generated with the openssl CLI rather than a JS X.509 library because no new
 * npm dependency can be installed here, and Node's crypto can read certificates
 * but not issue them. Roughly 200ms per suite, once, cached in a module-level
 * singleton.
 */

/** Apple's WWDR intermediate extension OID, which the verifier requires. */
const WWDR_OID = '1.2.840.113635.100.6.2.1';

export interface IAppleTestChain {
  /** DER-base64 certificates, in x5c order: leaf, intermediate, root. */
  readonly x5c: string[];
  /** PEM of the leaf's private key — used to sign test JWSs. */
  readonly leafPrivateKeyPem: string;
  /** Uppercase hex SHA-256 of the root, for the verifier's pin. */
  readonly rootFingerprint: string;
  /** A complete, unrelated chain whose root is NOT pinned. */
  readonly foreign: { x5c: string[]; leafPrivateKeyPem: string; rootFingerprint: string };
}

let cached: IAppleTestChain | null = null;

export function appleTestChain(): IAppleTestChain {
  if (cached) return cached;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abny-apple-chain-'));
  const primary = generateChain(dir, 'primary');
  const foreign = generateChain(dir, 'foreign');
  cached = { ...primary, foreign };
  return cached;
}

interface IChain {
  x5c: string[];
  leafPrivateKeyPem: string;
  rootFingerprint: string;
}

function generateChain(dir: string, prefix: string): IChain {
  const p = (name: string) => path.join(dir, `${prefix}-${name}`);
  const openssl = (...args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });

  // --- ROOT: self-signed, as a real root is. The verifier checks this. ---
  openssl('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', p('root.key'));
  openssl(
    'req', '-new', '-x509', '-key', p('root.key'), '-out', p('root.pem'),
    '-days', '3650', '-subj', `/CN=ABNY Test Root ${prefix}`, '-sha256',
  );

  // --- INTERMEDIATE: carries the Apple WWDR extension OID the verifier
  //     requires of the second-from-last certificate. ---
  const intermediateExt = p('intermediate.ext');
  fs.writeFileSync(
    intermediateExt,
    ['basicConstraints=critical,CA:TRUE', 'keyUsage=critical,keyCertSign,cRLSign', `${WWDR_OID}=DER:05:00`].join('\n'),
  );
  openssl('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', p('intermediate.key'));
  openssl(
    'req', '-new', '-key', p('intermediate.key'), '-out', p('intermediate.csr'),
    '-subj', `/CN=ABNY Test WWDR Intermediate ${prefix}`,
  );
  openssl(
    'x509', '-req', '-in', p('intermediate.csr'), '-CA', p('root.pem'), '-CAkey', p('root.key'),
    '-CAcreateserial', '-out', p('intermediate.pem'), '-days', '3650', '-sha256',
    '-extfile', intermediateExt,
  );

  // --- LEAF: the signing certificate. ---
  openssl('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', p('leaf.key'));
  openssl('req', '-new', '-key', p('leaf.key'), '-out', p('leaf.csr'), '-subj', `/CN=ABNY Test Leaf ${prefix}`);
  openssl(
    'x509', '-req', '-in', p('leaf.csr'), '-CA', p('intermediate.pem'), '-CAkey', p('intermediate.key'),
    '-CAcreateserial', '-out', p('leaf.pem'), '-days', '3650', '-sha256',
  );

  const der = (pemPath: string): string =>
    new crypto.X509Certificate(fs.readFileSync(pemPath)).raw.toString('base64');

  return {
    x5c: [der(p('leaf.pem')), der(p('intermediate.pem')), der(p('root.pem'))],
    leafPrivateKeyPem: fs.readFileSync(p('leaf.key'), 'utf8'),
    rootFingerprint: new crypto.X509Certificate(fs.readFileSync(p('root.pem'))).fingerprint256,
  };
}

// ---------------------------------------------------------------------------
// JWS construction
// ---------------------------------------------------------------------------

function b64url(value: Buffer | string): string {
  return (typeof value === 'string' ? Buffer.from(value, 'utf8') : value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Signs a payload exactly as Apple does: ES256, raw r||s signature
 * (`ieee-p1363`), x5c chain in the header.
 */
export function signAppleJws(payload: unknown, chain?: { x5c: string[]; leafPrivateKeyPem: string }): string {
  const c = chain ?? appleTestChain();
  const header = b64url(JSON.stringify({ alg: 'ES256', x5c: c.x5c }));
  const body = b64url(JSON.stringify(payload));
  const signature = crypto.sign(
    'sha256',
    Buffer.from(`${header}.${body}`, 'ascii'),
    { key: c.leafPrivateKeyPem, dsaEncoding: 'ieee-p1363' },
  );
  return `${header}.${body}.${b64url(signature)}`;
}

/**
 * NEGATIVE CONTROL: a perfectly valid, internally consistent chain that simply
 * is not Apple's. This is the exact attack the root pin exists to stop, and a
 * verifier that skipped the pin would accept it.
 */
export function buildForeignChainJws(payload: unknown): string {
  return signAppleJws(payload, appleTestChain().foreign);
}

/**
 * NEGATIVE CONTROL: `alg: "none"` — the oldest JWT attack there is. Also used
 * with 'HS256' to exercise the algorithm-confusion downgrade.
 */
export function buildAlgNoneJws(payload: unknown, alg = 'none'): string {
  const header = b64url(JSON.stringify({ alg, x5c: appleTestChain().x5c }));
  return `${header}.${b64url(JSON.stringify(payload))}.`;
}

/**
 * NEGATIVE CONTROL: keep the genuine signature, swap the payload. This is the
 * tampered-amount attack in its purest form.
 */
export function tamperPayload(jws: string, mutate: (payload: Record<string, unknown>) => void): string {
  const [header, body, signature] = jws.split('.');
  const payload = JSON.parse(
    Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
  ) as Record<string, unknown>;
  mutate(payload);
  return `${header}.${b64url(JSON.stringify(payload))}.${signature}`;
}
