import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { argv, env, stdout } from 'node:process';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const IOS_BUNDLE_ID = 'work.bonifacio.feelmyrythm';
export const ANDROID_PACKAGE_NAME = 'work.bonifacio.feelmyrythm';

export function normalizeTeamID(value) {
  const teamID = value.trim().toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(teamID)) {
    throw new Error('Apple Team ID must contain exactly 10 uppercase letters or digits.');
  }
  return teamID;
}

export function normalizeCertificateFingerprint(value) {
  const compact = value.replaceAll(':', '').replaceAll(' ', '').trim().toUpperCase();
  if (!/^[A-F0-9]{64}$/.test(compact)) {
    throw new Error('Android certificate fingerprint must contain exactly 32 SHA-256 bytes.');
  }
  return compact.match(/.{2}/g).join(':');
}

export function parseKeytoolCertificateFingerprint(output) {
  const match = output.match(/SHA256:\s*([A-F0-9:]+)/i);
  if (!match) throw new Error('keytool output did not contain a SHA-256 certificate fingerprint');
  return normalizeCertificateFingerprint(match[1]);
}

export function buildAssociationFiles({ teamID, certificateFingerprint }) {
  const normalizedTeamID = normalizeTeamID(teamID);
  const normalizedFingerprint = normalizeCertificateFingerprint(certificateFingerprint);
  return {
    appleAppSiteAssociation: {
      applinks: {
        apps: [],
        details: [
          {
            appIDs: [`${normalizedTeamID}.${IOS_BUNDLE_ID}`],
            components: [
              { '/': '/feelmyrythm/session/*', comment: 'Ensemble session invitations' },
              { '/': '/feelmyrythm/login', comment: 'Single-use account credentials' },
              { '/': '/feelmyrythm/settings', comment: 'Single-use account deletion proof' },
            ],
          },
        ],
      },
    },
    assetLinks: [
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: ANDROID_PACKAGE_NAME,
          sha256_cert_fingerprints: [normalizedFingerprint],
        },
      },
    ],
  };
}

export async function writeAssociationFiles(outputDirectory, values) {
  const output = resolve(outputDirectory);
  await mkdir(output, { recursive: true });
  const files = buildAssociationFiles(values);
  await Promise.all([
    writeFile(
      resolve(output, 'apple-app-site-association'),
      `${JSON.stringify(files.appleAppSiteAssociation, null, 2)}\n`,
      { mode: 0o644 },
    ),
    writeFile(
      resolve(output, 'assetlinks.json'),
      `${JSON.stringify(files.assetLinks, null, 2)}\n`,
      {
        mode: 0o644,
      },
    ),
  ]);
  return output;
}

async function main() {
  const cliArguments = argv.slice(2).filter((argument) => argument !== '--');
  const { values } = parseArgs({
    args: cliArguments,
    options: {
      'output-dir': { type: 'string' },
      'team-id': { type: 'string' },
      fingerprint: { type: 'string' },
    },
    strict: true,
  });
  const outputDirectory = values['output-dir'];
  if (!outputDirectory) throw new Error('--output-dir is required.');
  const teamID = values['team-id'] ?? env.FMR_IOS_DEVELOPMENT_TEAM;
  const certificateFingerprint = values.fingerprint ?? env.FMR_ANDROID_CERT_SHA256;
  if (!teamID || !certificateFingerprint) {
    throw new Error(
      'Provide --team-id/--fingerprint or FMR_IOS_DEVELOPMENT_TEAM/FMR_ANDROID_CERT_SHA256.',
    );
  }
  const output = await writeAssociationFiles(outputDirectory, { teamID, certificateFingerprint });
  stdout.write(`Wrote association files to ${output}\n`);
}

const invokedPath = argv[1] ? pathToFileURL(resolve(argv[1])).href : '';
if (import.meta.url === invokedPath) {
  await main();
}
