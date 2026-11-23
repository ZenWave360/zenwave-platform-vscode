import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The port test/smoke-remote.ts and test/fixtures/remote/arch/zenwave-architecture.yml name. */
export const SMOKE_REMOTE_PORT = 47813;

const root = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'test/fixtures/remote');

/**
 * A loopback http server over test/fixtures/remote: the remote manifest and the content it declares, with the CORS
 * headers a language server in a browser needs. No internet is involved.
 */
export function startRemoteFixture() {
  const server = http.createServer((request, response) => {
    const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
    if (request.method === 'OPTIONS') { response.writeHead(204, headers).end(); return; }
    const requested = path.normalize(decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname));
    const file = path.join(root, requested);
    if (!file.startsWith(root) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      response.writeHead(404, headers).end('not found');
      return;
    }
    response.writeHead(200, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' }).end(fs.readFileSync(file));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(SMOKE_REMOTE_PORT, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${SMOKE_REMOTE_PORT}`,
      close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(() => done()); }),
    }));
  });
}
