import { describe, expect, it } from 'vitest';
import currencyFixture from '../../../fixtures/quota-provider-v1/currency-v1.json';
import transportV3Fixture from '../../../fixtures/quota-provider-v1/transport-v3.json';
import type { QuotaWindowSnapshot } from '../../types';
import {
  parseQuotaProviderEnvelopes,
  validateQuotaWindowTimeline,
  validateQuotaWindowValues,
} from './quota';

function windowAccepted(window: QuotaWindowSnapshot): boolean {
  return validateQuotaWindowTimeline(window) && validateQuotaWindowValues(window) !== null;
}

describe('quota currency unit (quota-provider-v1 §2.2)', () => {
  it('accepts every valid balance window from the shared fixture', () => {
    const providers = parseQuotaProviderEnvelopes(currencyFixture.validProviders);
    const expected = currencyFixture.expected as Record<string, {
      windows: Record<string, { currency: string; remaining: number; sameCurrencyLimit: boolean }>;
    }>;
    expect(providers.map((provider) => provider.providerId)).toEqual(Object.keys(expected));
    for (const provider of providers) {
      for (const window of provider.windows) {
        const want = expected[provider.providerId].windows[window.windowId];
        expect(window.unit).toBe('currency');
        expect(window.currency).toBe(want.currency);
        const values = validateQuotaWindowValues(window);
        expect(values?.kind).toBe('absolute');
        if (values?.kind !== 'absolute') continue;
        expect(values.remaining).toBe(want.remaining);
        expect(values.limit !== undefined).toBe(want.sameCurrencyLimit);
        expect(windowAccepted(window)).toBe(true);
      }
    }
  });

  it.each(currencyFixture.cases.map((testCase) => [testCase.name, testCase] as const))(
    'rejects only the offending window for %s',
    (_name, testCase) => {
      expect(testCase.readerOutcome).toBe('reject-window');
      const providers = parseQuotaProviderEnvelopes(testCase.providers);
      const windows = providers.flatMap((provider) => provider.windows);
      expect(windows.some((window) => !windowAccepted(window))).toBe(true);
    },
  );

  it.each(currencyFixture.unknownUnitCases.map((testCase) => [testCase.name, testCase] as const))(
    'drops unknown-unit windows without failing the response for %s',
    (_name, testCase) => {
      const providers = parseQuotaProviderEnvelopes([testCase.provider]);
      if (!testCase.expected.kept) {
        expect(providers).toEqual([]);
        return;
      }
      expect(providers).toHaveLength(1);
      expect(providers[0].status).toBe(testCase.expected.status);
      expect(providers[0].windows.map((window) => window.windowId)).toEqual(testCase.expected.windowIds);
    },
  );

  it('keeps other providers when one envelope only carries unknown units', () => {
    const unknownOnly = currencyFixture.unknownUnitCases.find((testCase) => !testCase.expected.kept);
    const providers = parseQuotaProviderEnvelopes([
      unknownOnly?.provider,
      ...currencyFixture.validProviders,
    ]);
    expect(providers.map((provider) => provider.providerId))
      .toEqual(currencyFixture.validProviders.map((provider) => provider.providerId));
  });

  it('reads the v3 transport providers and the v2 projection that omits currency', () => {
    const v3 = parseQuotaProviderEnvelopes(transportV3Fixture.v3ReadResponse.providers);
    expect(v3.some((provider) => provider.windows.some((window) => window.unit === 'currency'))).toBe(true);
    const v2 = parseQuotaProviderEnvelopes(transportV3Fixture.v2ReadResponse.providers);
    expect(v2.every((provider) => provider.windows.every((window) => window.unit !== 'currency'))).toBe(true);
  });
});
