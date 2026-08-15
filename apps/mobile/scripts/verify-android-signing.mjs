import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import {
  normalizeCertificateFingerprint,
  parseKeytoolCertificateFingerprint,
} from './association-files.mjs';

const required = [
  'FMR_ANDROID_KEYSTORE_PATH',
  'FMR_ANDROID_KEYSTORE_PASSWORD',
  'FMR_ANDROID_KEY_ALIAS',
  'FMR_ANDROID_KEY_PASSWORD',
  'FMR_ANDROID_CERT_SHA256',
];
const missing = required.filter((name) => !process.env[name]?.trim());
if (missing.length > 0) {
  throw new Error(`Android release signing environment is incomplete: ${missing.join(', ')}`);
}

const storePath = process.env.FMR_ANDROID_KEYSTORE_PATH;
if (!storePath || !isAbsolute(storePath)) {
  throw new Error('FMR_ANDROID_KEYSTORE_PATH must be an absolute path');
}

let storeIsFile = false;
try {
  storeIsFile = statSync(storePath).isFile();
} catch {
  // Report one stable error without exposing any secret values.
}
if (!storeIsFile) {
  throw new Error('FMR_ANDROID_KEYSTORE_PATH must point to an existing file');
}

const keytool = spawnSync(
  'keytool',
  [
    '-list',
    '-v',
    '-keystore',
    storePath,
    '-alias',
    process.env.FMR_ANDROID_KEY_ALIAS,
    '-storepass:env',
    'FMR_ANDROID_KEYSTORE_PASSWORD',
  ],
  { encoding: 'utf8', env: process.env },
);
if (keytool.error || keytool.status !== 0) {
  throw new Error('keytool could not inspect the configured release alias');
}
const actualFingerprint = parseKeytoolCertificateFingerprint(keytool.stdout);
const expectedFingerprint = normalizeCertificateFingerprint(process.env.FMR_ANDROID_CERT_SHA256);
if (actualFingerprint !== expectedFingerprint) {
  throw new Error('FMR_ANDROID_CERT_SHA256 does not match the configured release alias');
}

process.stdout.write('Android release signing identity and environment are complete.\n');
