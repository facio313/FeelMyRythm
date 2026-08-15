import { describe, expect, it } from 'vitest';

import {
  ANDROID_PACKAGE_NAME,
  IOS_BUNDLE_ID,
  buildAssociationFiles,
  normalizeCertificateFingerprint,
  normalizeTeamID,
  parseKeytoolCertificateFingerprint,
} from '../scripts/association-files.mjs';

describe('mobile association files', () => {
  it('generates the exact app identities and narrow public paths', () => {
    const generated = buildAssociationFiles({
      teamID: 'a1b2c3d4e5',
      certificateFingerprint: '11'.repeat(32),
    });

    expect(generated.appleAppSiteAssociation.applinks.details).toEqual([
      {
        appIDs: [`A1B2C3D4E5.${IOS_BUNDLE_ID}`],
        components: [
          { '/': '/feelmyrythm/session/*', comment: 'Ensemble session invitations' },
          { '/': '/feelmyrythm/login', comment: 'Single-use account credentials' },
          { '/': '/feelmyrythm/settings', comment: 'Single-use account deletion proof' },
        ],
      },
    ]);
    expect(generated.assetLinks).toEqual([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: ANDROID_PACKAGE_NAME,
          sha256_cert_fingerprints: [Array(32).fill('11').join(':')],
        },
      },
    ]);
  });

  it('normalizes valid identities and rejects placeholders or malformed values', () => {
    expect(normalizeTeamID('ab12cd34ef')).toBe('AB12CD34EF');
    expect(normalizeCertificateFingerprint(Array(32).fill('ab').join(':'))).toBe(
      Array(32).fill('AB').join(':'),
    );
    expect(() => normalizeTeamID('TEAMID')).toThrow(/10/);
    expect(() => normalizeCertificateFingerprint('AA:BB')).toThrow(/32 SHA-256 bytes/);
    expect(
      parseKeytoolCertificateFingerprint(
        `Certificate fingerprints:\n\t SHA256: ${'AB:'.repeat(31)}AB`,
      ),
    ).toBe(Array(32).fill('AB').join(':'));
    expect(() => parseKeytoolCertificateFingerprint('SHA1: AA:BB')).toThrow(/SHA-256/);
  });
});
