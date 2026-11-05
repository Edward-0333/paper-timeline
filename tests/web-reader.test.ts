import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchPublicWebText, isPublicWebAddress, publicWebUrl, readPublicWebPage, WebReadError,
  type WebHopRequest, type WebHopResponse, type WebReaderDependencies } from '../electron/web-reader';

const signal = () => new AbortController().signal;
const response = (body: string, type = 'text/html'): WebHopResponse => ({ status: 200,
  headers: { 'content-type': type }, body: Buffer.from(body) });
const publicAddress = { address: '93.184.215.14', family: 4 };
function fixture(request: (request: WebHopRequest) => Promise<WebHopResponse> = async () => response('<title>Test title</title><p>Public article text.</p>')) {
  const calls: WebHopRequest[] = [], resolved: string[] = [];
  const deps: WebReaderDependencies = {
    resolve: async hostname => { resolved.push(hostname); return [publicAddress]; },
    request: async input => { calls.push(input); return request(input); },
  };
  return { deps, calls, resolved };
}

test('web URL validation blocks local protocols, credentials, ports and disguised private addresses', () => {
  for (const value of ['file:///etc/passwd', 'data:text/plain,hello', 'ftp://example.org/', 'https://a:b@example.org/',
    'http://localhost/', 'http://localhost./', 'http://service.local/', 'http://host/', 'http://example.org:8080/',
    'http://127.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://0177.0.0.1/', 'http://169.254.169.254/',
    'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[64:ff9b::7f00:1]/', 'http://[fe80::1]/', 'https://example.org/\npath']) {
    assert.throws(() => publicWebUrl(value), WebReadError, value);
  }
  assert.equal(publicWebUrl('https://example.org:443/page#anchor').toString(), 'https://example.org/page');
  assert.equal(publicWebUrl('http://8.8.8.8/').hostname, '8.8.8.8');
});

test('address classifier rejects special IPv4/IPv6 ranges while permitting ordinary public unicast', () => {
  for (const ip of ['0.0.0.0', '10.0.0.1', '100.64.0.1', '100.127.255.254', '127.0.0.1', '169.254.5.6', '172.16.0.1',
    '172.31.255.255', '192.0.0.170', '192.0.2.1', '192.88.99.2', '192.168.1.1', '198.18.1.1', '198.19.1.1',
    '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', '::', '::1', '::ffff:7f00:1', '::ffff:8.8.8.8',
    '64:ff9b::a00:1', '2001::a00:1', '2001:2::1', '2001:db8::1', '2002:a00:1::1', '3fff::1', 'fc00::1', 'fe80::1', 'ff02::1']) {
    assert.equal(isPublicWebAddress(ip), false, ip);
  }
  for (const ip of ['1.1.1.1', '8.8.8.8', '100.128.0.1', '172.32.0.1', '93.184.215.14', '2606:4700:4700::1111', '2001:4860:4860::8888']) {
    assert.equal(isPublicWebAddress(ip), true, ip);
  }
});

test('every DNS answer must be public and the approved destination is passed to the pinned transport', async () => {
  const f = fixture();
  const page = await readPublicWebPage('https://example.org/article', { signal: signal() }, f.deps);
  assert.equal(page.content, 'Public article text.'); assert.equal(page.title, 'Test title');
  assert.deepEqual(f.resolved, ['example.org']); assert.deepEqual(f.calls[0].address, publicAddress);
  let calls = 0;
  for (const addresses of [[], [{ address: '127.0.0.1', family: 4 }], [publicAddress, { address: '10.1.1.1', family: 4 }],
    [{ address: publicAddress.address, family: 6 }]]) {
    await assert.rejects(readPublicWebPage('https://example.org/', { signal: signal() }, {
      resolve: async () => addresses, request: async () => { calls++; return response('not allowed'); },
    }), /公网地址/);
  }
  assert.equal(calls, 0);
});

test('redirects are independently validated, DNS rebinding to private target is blocked and loops bounded', async () => {
  const f = fixture(async input => input.url.pathname === '/start'
    ? { status: 302, headers: { location: '/article' }, body: new Uint8Array() } : response('<p>Redirected article</p>'));
  assert.equal((await readPublicWebPage('https://example.org/start', { signal: signal() }, f.deps)).url, 'https://example.org/article');
  assert.deepEqual(f.resolved, ['example.org', 'example.org']);
  for (const location of ['http://example.org/', 'https://127.0.0.1/', 'https://user:secret@example.org/', 'https://example.org:8444/', 'file:///secret']) {
    const redirected = fixture(async () => ({ status: 302, headers: { location }, body: new Uint8Array() }));
    await assert.rejects(readPublicWebPage('https://example.org/', { signal: signal() }, redirected.deps), WebReadError);
    assert.equal(redirected.calls.length, 1);
  }
  let lookups = 0, transportCalls = 0;
  await assert.rejects(readPublicWebPage('https://example.org/', { signal: signal() }, {
    resolve: async () => ++lookups === 1 ? [publicAddress] : [{ address: '127.0.0.1', family: 4 }],
    request: async () => { transportCalls++; return { status: 302, headers: { location: '/second' }, body: new Uint8Array() }; },
  }), /公网地址/);
  assert.equal(transportCalls, 1);
  const loop = fixture(async () => ({ status: 302, headers: { location: '/again' }, body: new Uint8Array() }));
  await assert.rejects(readPublicWebPage('https://example.org/', { signal: signal() }, loop.deps), /重定向次数/);
  assert.equal(loop.calls.length, 5);
});

test('HTML extraction removes executable and hidden content and returns bounded continuations', async () => {
  const article = 'Useful evidence. '.repeat(40);
  const f = fixture(async () => response(`<html><title>Evidence &amp; methods</title><body><nav>MENU SECRET</nav><script>EXECUTE SECRET</script>
    <main><h1>Evidence</h1><p>${article}</p><img src="http://127.0.0.1/secret"><iframe src="file:///secret">FRAME SECRET</iframe>
    <span hidden>HIDDEN SECRET</span><span style="display:none">STYLE SECRET</span><form>FORM SECRET</form></main>
    <footer>FOOTER SECRET</footer></body></html>`));
  const first = await readPublicWebPage('https://example.org/', { signal: signal(), maxCharacters: 100 }, f.deps);
  assert.equal(first.title, 'Evidence & methods'); assert.equal(first.content.length, 100); assert.equal(first.nextOffset, 100);
  assert.equal(first.truncated, true); assert.match(first.retrievedAt, /^\d{4}-/); assert.ok(!first.content.includes('SECRET'));
  const rest = await readPublicWebPage('https://example.org/', { signal: signal(), offset: 100, maxCharacters: 20000 }, f.deps);
  assert.equal(rest.nextOffset, null); assert.ok(!rest.content.includes('SECRET')); assert.ok(!rest.content.includes('http://127.0.0.1'));
  assert.equal(first.content.length + rest.content.length, first.totalCharacters);
  await assert.rejects(readPublicWebPage('https://example.org/', { signal: signal(), offset: 200000 }, f.deps), /超出正文/);
});

test('source extraction cap and page limit are explicit rather than silently claiming full content', async () => {
  const f = fixture(async () => response('x'.repeat(210000), 'text/plain'));
  const last = await readPublicWebPage('https://example.org/', { signal: signal(), offset: 199990, maxCharacters: 20 }, f.deps);
  assert.equal(last.content.length, 10); assert.equal(last.totalCharacters, 200000); assert.equal(last.nextOffset, null); assert.equal(last.truncated, true);
  for (const options of [{ offset: -1 }, { offset: 0.5 }, { maxCharacters: 0 }, { maxCharacters: 20001 }]) {
    await assert.rejects(readPublicWebPage('https://example.org/', { signal: signal(), ...options }, f.deps), /分页参数/);
  }
});

test('downloads, binary bodies, unsupported compression and large bodies fail safely', async () => {
  for (const [headers, body] of [
    [{ 'content-type': 'application/pdf' }, '%PDF-1.0'], [{ 'content-type': 'image/png' }, 'binary'],
    [{ 'content-type': 'text/html', 'content-disposition': 'attachment; filename=test.html' }, '<p>download</p>'],
    [{ 'content-type': 'text/plain', 'content-encoding': 'gzip' }, 'compressed'],
  ] as [Record<string, string>, string][]) {
    await assert.rejects(readPublicWebPage('https://example.org/', { signal: signal() }, fixture(async () => ({ status: 200, headers, body: Buffer.from(body) })).deps), WebReadError);
  }
  await assert.rejects(fetchPublicWebText('https://example.org/', { signal: signal(), maxBytes: 10 }, fixture(async () => response('x'.repeat(11), 'text/plain')).deps), /过大/);
  await assert.rejects(readPublicWebPage('https://example.org/', { signal: signal() }, fixture(async () => response('<script>only script</script>')).deps), /没有提取到/);
});

test('abort/timeout also bound stalled DNS and injected transport, and network errors never expose private messages', async () => {
  const wait = () => new Promise<never>(() => {});
  await assert.rejects(fetchPublicWebText('https://example.org/', { signal: signal(), timeoutMs: 10 }, { resolve: wait }), /超时/);
  await assert.rejects(fetchPublicWebText('https://example.org/', { signal: signal(), timeoutMs: 10 }, fixture(wait).deps), /超时/);
  const controller = new AbortController(), pending = readPublicWebPage('https://example.org/', { signal: controller.signal }, fixture(wait).deps);
  controller.abort(new Error('cancelled-by-user')); await assert.rejects(pending, /cancelled-by-user/);
  await assert.rejects(readPublicWebPage('https://example.org/', { signal: signal() }, {
    resolve: async () => { throw new Error('SECRET token and C:\\private\\config'); },
  }), error => error instanceof WebReadError && error.message.includes('无法连接') && !error.message.includes('SECRET'));
  await assert.rejects(readPublicWebPage('https://example.org/', { signal: signal() }, fixture(async () => ({
    status: 403, headers: {}, body: Buffer.from('PRIVATE SERVER BODY'),
  })).deps), error => error instanceof WebReadError && error.message === '网页读取失败（HTTP 403）。');
});
