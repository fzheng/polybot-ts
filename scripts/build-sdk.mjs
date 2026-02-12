/**
 * Postinstall script: builds @catalyst-team/poly-sdk if dist/ is missing.
 *
 * The SDK is installed from GitHub but only ships source (no pre-built dist/).
 * Its package.json has `prepublishOnly` (not `prepare`), so npm never builds
 * it during a git install. This script fills that gap.
 *
 * Runs automatically after `npm install`. Safe to re-run — skips if already built.
 */

import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sdkDir = resolve(__dirname, '..', 'node_modules', '@catalyst-team', 'poly-sdk');
const sdkDist = resolve(sdkDir, 'dist', 'src', 'index.js');

if (!existsSync(sdkDir)) {
  console.log('[build-sdk] SDK not installed yet, skipping');
  process.exit(0);
}

if (existsSync(sdkDist)) {
  console.log('[build-sdk] SDK already built, skipping');
  process.exit(0);
}

// Check if source exists (git install includes src/, npm pack does not)
const sdkSrc = resolve(sdkDir, 'src', 'index.ts');
if (!existsSync(sdkSrc)) {
  console.error('[build-sdk] SDK source not found — was it installed from npm instead of GitHub?');
  console.error('[build-sdk] Expected:', sdkSrc);
  process.exit(1);
}

console.log('[build-sdk] Building @catalyst-team/poly-sdk...');
try {
  execSync('npm install --ignore-scripts', { cwd: sdkDir, stdio: 'pipe' });
  execSync('npx tsc', { cwd: sdkDir, stdio: 'pipe' });
  console.log('[build-sdk] SDK built successfully');
} catch (err) {
  console.error('[build-sdk] Failed to build SDK:', err.message);
  process.exit(1);
}
