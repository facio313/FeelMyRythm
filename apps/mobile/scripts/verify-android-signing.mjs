import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import process from 'node:process';

const required = [
  'FMR_ANDROID_KEYSTORE_PATH',
  'FMR_ANDROID_KEYSTORE_PASSWORD',
  'FMR_ANDROID_KEY_ALIAS',
  'FMR_ANDROID_KEY_PASSWORD',
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

process.stdout.write('Android release signing environment is complete.\n');
