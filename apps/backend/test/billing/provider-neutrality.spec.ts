import * as fs from 'fs';
import * as path from 'path';

import { ConfigService } from '@nestjs/config';

import { PaymentProviderRegistry } from '../../src/modules/billing/infrastructure/adapters/payment-provider.registry';
import { ManualPaymentAdapter } from '../../src/modules/billing/infrastructure/adapters/manual-payment.adapter';
import { StripeAdapter } from '../../src/modules/billing/infrastructure/adapters/stripe.adapter';
import { PaymobProvider } from '../../src/modules/billing/infrastructure/adapters/paymob.provider';
import { FawryProvider } from '../../src/modules/billing/infrastructure/adapters/fawry.provider';
import { MoyasarProvider } from '../../src/modules/billing/infrastructure/adapters/moyasar.provider';
import { AppleStoreKitProvider } from '../../src/modules/billing/infrastructure/adapters/apple-storekit.provider';
import { GooglePlayProvider } from '../../src/modules/billing/infrastructure/adapters/google-play.provider';

/**
 * PHASE D — THE ARCHITECTURAL INVARIANT, ENFORCED BY A TEST THAT READS SOURCE.
 *
 * «No provider-specific logic inside `SubscriptionService`» and «feature access
 * anywhere in the app resolves through `Entitlement`, never through which
 * provider paid» are the two rules the whole abstraction exists to enforce. A
 * rule of that kind survives exactly as long as someone is checking, and code
 * review is not a mechanism.
 *
 * So this suite GREPS THE APPLICATION LAYER for provider literals. It is the
 * same technique `scripts/ci/assert-tenant-scoping.ts` uses for tenant leaks,
 * and it works for the same reason: the violation has a textual signature.
 *
 * TWO DELIBERATE EXCEPTIONS, both listed by name rather than excluded by a
 * pattern, so that adding a third requires editing this list and writing down
 * why:
 *
 *  1. `payment-webhook.controller.ts` maps a URL segment to a provider enum.
 *     Routing is not business logic — something has to know that
 *     `/webhooks/payments/apple` means Apple. It is a lookup table, and the
 *     test below asserts it contains no `if`/`switch` on a provider value.
 *
 *  2. `services/stripe-webhook.service.ts` is SPRINT 8 CODE that Phase D
 *     deliberately did not rewrite. It is a genuinely provider-specific
 *     service sitting in the application layer — a real, pre-existing
 *     violation of this rule, and the honest thing is to name it rather than
 *     to loosen the rule until it passes. Stripe is the INTERNATIONAL
 *     provider and out of Phase D's scope (Egypt and Saudi Arabia); rewriting
 *     a working integration to satisfy a test, in a phase that is not about
 *     it, would be scope creep. Folding it into `PaymentWebhookService` as a
 *     `StripeProvider` adapter is listed as follow-up work in
 *     PHASE-D-Payments-Report.md.
 */

const APPLICATION_LAYER = path.resolve(__dirname, '../../src/modules/billing/application');

/** See exception 2 in the file docstring. Named, not pattern-excluded. */
const KNOWN_EXCEPTIONS = ['services/stripe-webhook.service.ts'];

/** Every value of the `PaymentProvider` enum. */
const PROVIDER_LITERALS = ['APPLE_IAP', 'GOOGLE_PLAY', 'PAYMOB', 'FAWRY', 'MOYASAR', 'STRIPE'];

/** Vendor names that would betray provider-aware logic even without the enum. */
const VENDOR_WORDS = ['Apple', 'Google', 'Paymob', 'Fawry', 'Moyasar', 'StoreKit', 'PlayBilling'];

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.isFile() && full.endsWith('.ts')) acc.push(full);
  }
  return acc;
}

function isException(file: string): boolean {
  const relative = path.relative(APPLICATION_LAYER, file).split(path.sep).join('/');
  return KNOWN_EXCEPTIONS.includes(relative);
}

/**
 * Strips comments and string-literal-free prose. Provider names appear all over
 * the DOCUMENTATION in these files — deliberately, because explaining that
 * Google's RTDN carries no purchase data is the point of the comment. What must
 * not appear is a provider name in EXECUTABLE code.
 */
function executableLines(source: string): Array<{ line: number; text: string }> {
  const withoutBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '));
  return withoutBlockComments
    .split('\n')
    .map((text, index) => ({ line: index + 1, text }))
    .filter(({ text }) => !/^\s*\/\//.test(text))
    .map(({ line, text }) => ({ line, text: text.replace(/\/\/.*$/, '') }));
}

describe('PHASE D — no provider-specific logic in the application layer', () => {
  const allFiles = walk(APPLICATION_LAYER);
  const files = allFiles.filter((f) => !isException(f));

  it('there is an application layer to check (a guard against this test passing vacuously)', () => {
    expect(files.length).toBeGreaterThan(8);
  });

  it('every named exception still exists — a stale allowlist silently widens the rule', () => {
    for (const relative of KNOWN_EXCEPTIONS) {
      expect(fs.existsSync(path.join(APPLICATION_LAYER, relative))).toBe(true);
    }
    expect(allFiles.length - files.length).toBe(KNOWN_EXCEPTIONS.length);
  });

  it.each(PROVIDER_LITERALS)('no executable line mentions the provider literal %s', (literal) => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const { line, text } of executableLines(fs.readFileSync(file, 'utf8'))) {
        if (text.includes(literal)) {
          offenders.push(`${path.relative(APPLICATION_LAYER, file)}:${line}: ${text.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it.each(VENDOR_WORDS)('no executable line mentions the vendor name %s', (vendor) => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const { line, text } of executableLines(fs.readFileSync(file, 'utf8'))) {
        if (new RegExp(`\\b${vendor}\\b`).test(text)) {
          offenders.push(`${path.relative(APPLICATION_LAYER, file)}:${line}: ${text.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no application-layer file imports a concrete adapter', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      if (/from '.*infrastructure\/adapters\//.test(source)) {
        offenders.push(path.relative(APPLICATION_LAYER, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('`EntitlementService.hasFeature` does not branch on the entitlement source', () => {
    // `source` is recorded because accounting and the Play refund rule need it.
    // If any access decision ever reads it, this goes red.
    const source = fs.readFileSync(path.join(APPLICATION_LAYER, 'services/entitlement.service.ts'), 'utf8');
    for (const { text } of executableLines(source)) {
      expect(text).not.toMatch(/\.source\s*===/);
      expect(text).not.toMatch(/switch\s*\(\s*\w*\.?source\s*\)/);
    }
  });

  it('the ONE deliberate exception is the webhook controller URL map, and it is the only one', () => {
    const controller = path.resolve(
      __dirname,
      '../../src/modules/billing/presentation/controllers/payment-webhook.controller.ts',
    );
    const source = fs.readFileSync(controller, 'utf8');
    // Routing has to know that /webhooks/payments/apple means Apple. It is a
    // lookup table, not a branch: assert there is no `if`/`switch` on a
    // provider value anywhere in it.
    expect(source).toContain('PROVIDER_ROUTES');
    for (const { text } of executableLines(source)) {
      expect(text).not.toMatch(/if\s*\(.*(APPLE_IAP|GOOGLE_PLAY|PAYMOB|FAWRY|MOYASAR)/);
      expect(text).not.toMatch(/switch\s*\(\s*provider\s*\)/);
    }
  });
});

describe('PHASE D — the registry is exhaustive over the provider enum', () => {
  const noConfig = () => ({ get: jest.fn(() => undefined) }) as unknown as ConfigService;
  const registry = new PaymentProviderRegistry(
    new ManualPaymentAdapter(),
    new StripeAdapter(noConfig()),
    new PaymobProvider(noConfig()),
    new FawryProvider(noConfig()),
    new MoyasarProvider(noConfig()),
    new AppleStoreKitProvider(noConfig()),
    new GooglePlayProvider(noConfig()),
  );

  it('resolves an adapter for every one of the seven providers', () => {
    for (const provider of ['MANUAL', 'STRIPE', 'PAYMOB', 'FAWRY', 'MOYASAR', 'APPLE_IAP', 'GOOGLE_PLAY'] as const) {
      const adapter = registry.getAdapter(provider);
      expect(adapter.providerName).toBe(provider);
      // Every adapter satisfies the FULL interface — that is what lets a caller
      // ask what a provider can do instead of asking which one it is.
      expect(typeof adapter.isConfigured).toBe('function');
      expect(typeof adapter.supports).toBe('function');
      expect(typeof adapter.verifyPurchase).toBe('function');
      expect(typeof adapter.verifyWebhookSignature).toBe('function');
      expect(typeof adapter.parseWebhook).toBe('function');
      // And the Sprint 8 contract, which is why the old charge() path still works.
      expect(typeof adapter.charge).toBe('function');
    }
    expect(registry.all()).toHaveLength(7);
  });

  it('an unregistered provider is a named exception, not an undefined dereference deep in a payment path', () => {
    expect(() => registry.getAdapter('NOT_A_PROVIDER' as never)).toThrow(/No payment provider adapter/);
  });

  it('the store/gateway split is declared, not inferred', () => {
    expect(registry.getAdapter('APPLE_IAP').kind).toBe('STORE');
    expect(registry.getAdapter('GOOGLE_PLAY').kind).toBe('STORE');
    expect(registry.getAdapter('PAYMOB').kind).toBe('GATEWAY');
    expect(registry.getAdapter('FAWRY').kind).toBe('GATEWAY');
    expect(registry.getAdapter('MOYASAR').kind).toBe('GATEWAY');
    expect(registry.getAdapter('MANUAL').kind).toBe('MANUAL');
  });
});
