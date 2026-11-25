'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const root = __dirname;
const serverPath = path.join(root, 'server.js');
const source = fs.readFileSync(serverPath, 'utf8');
const relativeRequires = [...source.matchAll(/require\(['"]([.][^'"]+)['"]\)/g)]
  .map(match => match[1]);
for (const request of relativeRequires) {
  const resolved = require.resolve(path.resolve(root, request));
  assert.ok(fs.existsSync(resolved), `Missing runtime module: ${request}`);
}

function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = address.port;
      probe.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function main() {
  const port = await getAvailablePort();
  const child = spawn(process.execPath, [serverPath], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      SUPABASE_URL: '',
      SUPABASE_KEY: '',
      SUPABASE_SERVICE_ROLE_KEY: '',
      TELEGRAM_BOT_TOKEN: '',
      ENABLE_BACKGROUND_WORKER: 'false',
      REGISTER_TELEGRAM_WEBHOOK: 'false'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });
  try {
    const deadline = Date.now() + 12000;
    let response = null;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Server exited early: ${output}`);
      try {
        response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
        if (response.status === 200) break;
      } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    assert.ok(response && response.status === 200, `/health did not return 200. Output: ${output}`);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.backgroundWorkerEnabled, false);
    assert.equal(body.webhookRegistrationEnabled, false);

    for (const [route, expectedText] of [
      ['/terms', 'Публічна оферта'],
      ['/privacy', 'Політика конфіденційності']
    ]) {
      const pageResponse = await fetch(`http://127.0.0.1:${port}${route}`, { signal: AbortSignal.timeout(1500) });
      assert.equal(pageResponse.status, 200, `${route} did not return 200`);
      const pageText = await pageResponse.text();
      assert.ok(pageText.includes('ЧЕРНЕТКА'), `${route} must visibly identify the document as draft`);
      assert.ok(pageText.includes(expectedText), `${route} returned the wrong document`);
    }

    for (const route of ['/api/legal/terms', '/api/legal/privacy']) {
      const legalResponse = await fetch(`http://127.0.0.1:${port}${route}`, { signal: AbortSignal.timeout(1500) });
      assert.equal(legalResponse.status, 200, `${route} did not return 200`);
      const legalBody = await legalResponse.json();
      assert.equal(legalBody.status, 'draft');
      assert.ok(Array.isArray(legalBody.content) && legalBody.content.length > 0);
    }
    process.stdout.write('Production boot smoke passed: relative modules resolve and /health returns 200.\n');
  } finally {
    child.kill('SIGTERM');
  }
}

main().catch(error => {
  process.stderr.write(String(error.stack || error) + '\n');
  process.exitCode = 1;
});
