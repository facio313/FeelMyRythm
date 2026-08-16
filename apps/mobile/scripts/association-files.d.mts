export const IOS_BUNDLE_ID: string;
export const ANDROID_PACKAGE_NAME: string;

export function normalizeTeamID(value: string): string;
export function normalizeCertificateFingerprint(value: string): string;
export function parseKeytoolCertificateFingerprint(output: string): string;
export function buildAssociationFiles(values: { teamID: string; certificateFingerprint: string }): {
  appleAppSiteAssociation: {
    applinks: {
      apps: never[];
      details: Array<{
        appIDs: string[];
        components: Array<{ '/': string; comment: string }>;
      }>;
    };
  };
  assetLinks: Array<{
    relation: string[];
    target: {
      namespace: string;
      package_name: string;
      sha256_cert_fingerprints: string[];
    };
  }>;
};

export function writeAssociationFiles(
  outputDirectory: string,
  values: { teamID: string; certificateFingerprint: string },
): Promise<string>;
