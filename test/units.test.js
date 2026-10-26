import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { download, fetchJson, isFetchInternalError } from '../src/fetch.js';
import { clientAddress, trustedProxies, isPrivateAddress, Attempts } from '../src/guard.js';
import { TsProbe } from '../src/tsprobe.js';
import { behindOf } from '../src/streams.js';
import { readGitCommit, currentVersion } from '../src/version.js';
import { parseM3U, isVod } from '../src/m3u.js';
import { parseXmltv, parseXmltvTime } from '../src/xmltv.js';
import { normalizeName, matchChannels } from '../src/epgmatch.js';
import { nameCleaner } from '../src/filters.js';
import { categoryState, testRule, DEFAULT_EMPTY_EVENT_PATTERNS, DEFAULT_GUIDE_PATTERNS, compilePatterns, isEmptyEvent } from '../src/filters.js';
import { rewriteHls } from '../src/stream.js';
import { splitUrls, xcBase } from '../src/ingest.js';
import { firstText } from '../src/outputs/xc.js';
import { addCategories, parseJellyfin } from '../src/outputs/epg.js';
import { jsonObjects } from '../src/jsonstream.js';
import { parseEpisodeName } from '../src/vod.js';

test('parseM3U reads header, attributes, commas in names and player options', () => {
  const { header, entries } = parseM3U([
    '﻿#EXTM3U url-tvg="http://x/guide.xml"',
    '#EXTINF:-1 tvg-id="newsnet.us" tvg-name="NewsNet" tvg-logo="http://l/newsnet.png" group-title="US, News",NewsNet, International',
    '#EXTVLCOPT:http-user-agent=Foo',
    'http://p/1.ts',
    '#EXTINF:-1,No Attrs',
    '#EXTGRP:Misc',
    'http://p/2.ts',
    '',
  ].join('\r\n'));
  assert.equal(header['url-tvg'], 'http://x/guide.xml');
  assert.equal(entries.length, 2);
  assert.deepEqual(
    { name: entries[0].name, group: entries[0].group, id: entries[0].attrs['tvg-id'], opts: entries[0].opts },
    { name: 'NewsNet, International', group: 'US, News', id: 'newsnet.us', opts: ['#EXTVLCOPT:http-user-agent=Foo'] },
  );
  assert.equal(entries[1].group, 'Misc');
  assert.equal(entries[1].name, 'No Attrs');
});

test('isVod flags movie and series URLs but not live streams', () => {
  assert.ok(isVod('http://h/movie/u/p/1.mp4'));
  assert.ok(isVod('http://h/series/u/p/1.mkv'));
  assert.ok(!isVod('http://h/live/u/p/1.ts'));
  assert.ok(!isVod('http://h/u/p/1'));
});

test('parseXmltvTime handles offsets and missing zones', () => {
  assert.equal(parseXmltvTime('20240101120000 +0000'), Date.UTC(2024, 0, 1, 12) / 1000);
  assert.equal(parseXmltvTime('20240101120000 +0100'), Date.UTC(2024, 0, 1, 11) / 1000);
  assert.equal(parseXmltvTime('20240101120000 -0530'), Date.UTC(2024, 0, 1, 17, 30) / 1000);
  assert.equal(parseXmltvTime('20240101120000'), Date.UTC(2024, 0, 1, 12) / 1000);
  assert.equal(parseXmltvTime('garbage'), null);
});

test('parseXmltv keeps program inner markup and survives bad entities', async () => {
  const xml = `<?xml version="1.0"?><tv>
    <channel id="a"><display-name>Alpha HD</display-name><display-name>A</display-name><icon src="http://i/a.png"/></channel>
    <programme start="20240101000000 +0000" stop="20240101010000 +0000" channel="a">
      <title lang="en">News &amp; Weather</title><desc>Bad &nbsp; entity</desc><category>News</category><icon src="x.png"/>
    </programme>
  </tv>`;
  const chans = [];
  const progs = [];
  await parseXmltv(Readable.from([xml]), { onChannel: (c) => chans.push(c), onProgramme: (p) => progs.push(p) });
  assert.deepEqual(chans, [{ id: 'a', names: ['Alpha HD', 'A'], icon: 'http://i/a.png' }]);
  assert.equal(progs.length, 1);
  assert.equal(progs[0].title, 'News & Weather');
  assert.match(progs[0].xml, /<title lang="en">News &amp; Weather<\/title>/);
  assert.match(progs[0].xml, /<icon src="x.png"\/>/);
  assert.match(progs[0].xml, /<category>News<\/category>/);
});

test('normalizeName strips country prefixes and quality tags', () => {
  assert.equal(normalizeName('US: Sportsline HD'), 'sportsline');
  assert.equal(normalizeName('UK | Arena Sports Main Event FHD'), 'arenasportsmainevent');
  assert.equal(normalizeName('|US| A&E (East)'), 'aande');
  assert.equal(normalizeName('NewsNet - HD', false), 'newsnet');
});

test('matchChannels prefers manual, then tvg-id, then name', () => {
  const epg = [{ id: 'Sportsline.us', names: ['Sportsline'] }, { id: 'newsnet.us', names: ['NewsNet'] }];
  const m = matchChannels([
    { id: 1, name: 'X', tvg_id: 'sportsline.US' },
    { id: 2, name: 'US: NewsNet HD', tvg_id: '' },
    { id: 3, name: 'Nothing', tvg_id: 'none' },
    { id: 4, name: 'NewsNet', tvg_id: 'Sportsline.us', custom_epg_id: 'manual.id' },
  ], epg);
  assert.deepEqual(m.get(1), { epgId: 'Sportsline.us', how: 'tvg-id' });
  assert.deepEqual(m.get(2), { epgId: 'newsnet.us', how: 'name' });
  assert.deepEqual(m.get(3), { epgId: null, how: null });
  assert.deepEqual(m.get(4), { epgId: 'manual.id', how: 'manual' });
});

test('matchChannels matches a tvg-id against exact display names (HDHomeRun tuner numbers)', () => {
  const epg = [{ id: 'US101.hdhomerun.com', names: ['2.1', 'WCBS'] }, { id: 'US102.hdhomerun.com', names: ['12.1', 'WPIX'] }];
  const m = matchChannels([{ id: 1, name: 'WCBS-HD', tvg_id: '2.1' }, { id: 2, name: 'X', tvg_id: '12' }], epg);
  assert.deepEqual(m.get(1), { epgId: 'US101.hdhomerun.com', how: 'tvg-id' });
  assert.equal(m.get(2).how, null, 'no partial display-name matches');
});

test('default empty-event patterns', () => {
  const re = compilePatterns(DEFAULT_EMPTY_EVENT_PATTERNS);
  for (const idle of ['Match 03:', 'Gameday Pass 07 -', 'Event 12', 'Hoops 04 NO EVENT', 'Ball 09 no event ', 'Event 1 : ']) {
    assert.ok(isEmptyEvent(idle, re), `${idle} should count as empty`);
  }
  for (const live of ['Match 03: Team A vs Team B', 'Gameday Pass 07 - Team C at Team D', 'Event 12: Title Match', 'NO EVENT TONIGHT? no']) {
    assert.ok(!isEmptyEvent(live, re), `${live} should not count as empty`);
  }
  // Known trade-off of "ends with a number": a live event whose title ends in a number.
  assert.ok(isEmptyEvent('Event 01: Final 2026', re));
  assert.deepEqual(compilePatterns(['(', 'ok$']).map(String), ['/ok$/i'], 'invalid patterns are skipped');
});

test('readGitCommit handles detached, loose and packed refs; version.json wins', () => {
  const a = 'a'.repeat(40);
  const b = 'b'.repeat(40);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iptvm-ver-'));
  try {
    const git = path.join(root, '.git');
    fs.mkdirSync(path.join(git, 'refs', 'heads'), { recursive: true });
    fs.writeFileSync(path.join(git, 'HEAD'), `${a}\n`);
    assert.equal(readGitCommit(root), a, 'detached HEAD');
    fs.writeFileSync(path.join(git, 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(git, 'packed-refs'), `# pack-refs with: peeled\n${b} refs/heads/main\n`);
    assert.equal(readGitCommit(root), b, 'packed ref');
    fs.writeFileSync(path.join(git, 'refs', 'heads', 'main'), `${a}\n`);
    assert.equal(readGitCommit(root), a, 'loose ref beats packed');
    assert.deepEqual(currentVersion(root), { commit: a, source: 'git' });
    fs.writeFileSync(path.join(root, 'version.json'), JSON.stringify({ commit: b }));
    assert.deepEqual(currentVersion(root), { commit: b, source: 'build' });
    assert.equal(readGitCommit(path.join(root, 'nope')), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('default guide-title patterns', () => {
  const re = compilePatterns(DEFAULT_GUIDE_PATTERNS);
  for (const t of ['No Game Today', 'NO GAME TODAY - check back', 'No Event', 'No Events Scheduled', 'No Live Event', 'Off Air']) {
    assert.ok(isEmptyEvent(t, re), `${t} should count as a placeholder`);
  }
  for (const t of ['Team C at Team D', 'Game Day Live', 'Big Event Tonight', 'Offside: The Show', 'Is There No Event Horizon?']) {
    assert.ok(!isEmptyEvent(t, re), `${t} should not count as a placeholder`);
  }
});

test('rule operators', () => {
  const r = (op, value) => ({ op, value });
  assert.ok(testRule(r('contains', 'sport'), 'US| SPORTS'));
  assert.ok(testRule(r('not_contains', 'adult'), 'US| SPORTS'));
  assert.ok(testRule(r('starts_with', 'us|'), 'US| SPORTS'));
  assert.ok(!testRule(r('not_starts_with', 'us'), 'US| SPORTS'));
  assert.ok(testRule(r('ends_with', ' hd'), 'US: NewsNet HD'));
  assert.ok(!testRule(r('ends_with', 'hd'), 'HD Movies'));
  assert.ok(testRule(r('not_ends_with', 'backup'), 'Sportsline'));
  assert.ok(!testRule(r('not_ends_with', 'BACKUP'), 'Sportsline backup'), 'case-insensitive');
  assert.ok(testRule(r('ends_with', ''), 'anything'), 'an empty value matches like the other operators');
  assert.ok(testRule(r('regex', '^(us|uk)\\|'), 'UK| NEWS'));
  assert.ok(!testRule(r('regex', '('), 'anything'));
});

test('categoryState: manual beats rules, exclude beats include, default when no includes', () => {
  const rules = [
    { id: 1, source_id: null, action: 'include', op: 'starts_with', value: 'US' },
    { id: 2, source_id: null, action: 'exclude', op: 'contains', value: 'adult' },
    { id: 3, source_id: 9, action: 'include', op: 'contains', value: 'only9' },
  ];
  const cat = (name, source_id = 1) => ({ name, source_id });
  assert.equal(categoryState(cat('US| NEWS'), rules, null, 0).included, true);
  assert.equal(categoryState(cat('US| ADULT'), rules, null, 0).included, false);
  assert.equal(categoryState(cat('UK| NEWS'), rules, null, 0).included, false);
  assert.equal(categoryState(cat('UK| NEWS'), rules, 'include', 0).reason, 'manual');
  assert.equal(categoryState(cat('US| NEWS'), rules, 'exclude', 0).included, false);
  assert.equal(categoryState(cat('only9 stuff', 9), rules, null, 0).included, true);
  assert.deepEqual(categoryState(cat('anything'), [], null, 1), { included: true, reason: 'default' });
  assert.deepEqual(categoryState(cat('anything'), [], null, 0), { included: false, reason: 'default' });
});

test('rewriteHls routes playlist and key URIs through the mapper', () => {
  const out = rewriteHls('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:4,\nseg1.ts\n', 'http://up/a/index.m3u8', (u) => `P(${u})`);
  assert.match(out, /URI="P\(http:\/\/up\/a\/key.bin\)"/);
  assert.match(out, /^P\(http:\/\/up\/a\/seg1.ts\)$/m);
});

test('firstText pulls the first title/desc out of stored program markup', () => {
  const xml = '<title lang="en">News &amp; Weather</title><title lang="fr">Infos</title><desc>Line &lt;1&gt;</desc>';
  assert.equal(firstText(xml, 'title'), 'News & Weather');
  assert.equal(firstText(xml, 'desc'), 'Line <1>');
  assert.equal(firstText(xml, 'sub-title'), '');
  assert.equal(firstText('<desc/>', 'desc'), '');
});

test('parseJellyfin keeps known categories in canonical order and spelling', () => {
  assert.deepEqual(parseJellyfin('kids, movie,bogus'), ['Movie', 'Kids']);
  assert.deepEqual(parseJellyfin(null), []);
});

test('addCategories inserts after title/desc, before later elements, without duplicates', () => {
  assert.equal(
    addCategories('<title>A</title><desc>B</desc><icon src="i"/><episode-num>1</episode-num>', ['Sports']),
    '<title>A</title><desc>B</desc><category lang="en">Sports</category><icon src="i"/><episode-num>1</episode-num>',
  );
  assert.equal(
    addCategories('<title>A</title><category>sports</category><rating><value>G</value></rating>', ['Sports', 'Kids']),
    '<title>A</title><category>sports</category><category lang="en">Kids</category><rating><value>G</value></rating>',
  );
  assert.equal(addCategories('', ['News']), '<category lang="en">News</category>');
  assert.equal(addCategories('<title>A</title><category>News</category>', ['news']), '<title>A</title><category>News</category>');
});

test('splitUrls and xcBase normalize user input', () => {
  assert.deepEqual(splitUrls('http://a/x.xml\n\nhttp://b/y.xml, http://c/z.xml'), ['http://a/x.xml', 'http://b/y.xml', 'http://c/z.xml']);
  assert.equal(xcBase('provider.example:8080/'), 'http://provider.example:8080');
  assert.equal(xcBase('https://p.example/player_api.php?username=a'), 'https://p.example');
});

test('jsonObjects reads big JSON lists one object at a time, across chunks and tricky strings', async () => {
  const f = path.join(os.tmpdir(), `iptvm-json-${process.pid}.json`);
  const items = Array.from({ length: 5000 }, (_, i) => ({
    stream_id: i, name: `Movie {${i}} "quoted" \ back [x]`, plot: 'é'.repeat(i % 97), nested: { a: [1, { b: '}' }] },
  }));
  try {
    fs.writeFileSync(f, JSON.stringify(items)); // ~1 MB: several read chunks
    const got = [];
    for await (const [text, v] of jsonObjects(f)) {
      assert.deepEqual(JSON.parse(text), v);
      got.push(v);
    }
    assert.deepEqual(got, items);
    fs.writeFileSync(f, JSON.stringify({ 1: items[1], 2: items[2] }, null, 2)); // keyed by id
    const ids = [];
    for await (const [, v] of jsonObjects(f)) ids.push(v.stream_id);
    assert.deepEqual(ids, [1, 2]);
    for (const body of ['[]', '{}', 'null', '[1,2,"x"]']) {
      fs.writeFileSync(f, body);
      for await (const _ of jsonObjects(f)) assert.fail(`nothing expected from ${body}`);
    }
  } finally {
    fs.rmSync(f, { force: true });
  }
});

test('nameCleaner tidies only runs of spaces (a double "s" in a name is left alone)', () => {
  const clean = nameCleaner([{ scope: 'channel', find: 'HD', replace: '' }]);
  assert.equal(clean.channel('Boss  Glass HD'), 'Boss Glass');
  assert.equal(clean.channel('Mississippi'), 'Mississippi');
  assert.equal(nameCleaner([{ scope: 'channel', media: 'vod', find: 'x', replace: '' }]).channel('xx y'), 'xx y', 'VOD rules skip live TV');
  assert.equal(nameCleaner([{ scope: 'channel', media: 'all', find: 'x', replace: '' }], 'vod').channel('xx y'), 'y');
});

test('parseEpisodeName finds the show, season and episode in playlist names', () => {
  assert.deepEqual(parseEpisodeName('Lost S01 E02'), { show: 'Lost', season: 1, episode: 2 });
  assert.deepEqual(parseEpisodeName('The.Workplace.US.S03E14.720p'), { show: 'The Workplace US', season: 3, episode: 14 });
  assert.deepEqual(parseEpisodeName('EN - Dark - S2E10 - Title'), { show: 'EN - Dark', season: 2, episode: 10 });
  assert.equal(parseEpisodeName('Some Movie (2020)'), null);
  assert.equal(parseEpisodeName('S01 E01'), null, 'no show name');
});

test('isFetchInternalError recognizes only Node fetch\'s internal assertion', () => {
  const undici = Object.assign(new Error('The expression evaluated to a falsy value:\n\n  assert(!this.paused)\n'), { code: 'ERR_ASSERTION' });
  undici.stack = `AssertionError [ERR_ASSERTION]: ${undici.message}\n    at Parser.finish (node:internal/deps/undici/undici:7388:9)\n    at TLSSocket.onHttpSocketEnd (node:internal/deps/undici/undici:7827:34)`;
  assert.equal(isFetchInternalError(undici), true);
  const ours = Object.assign(new Error('x'), { code: 'ERR_ASSERTION' });
  ours.stack = 'AssertionError: x\n    at file:///app/src/ingest.js:10:3';
  assert.equal(isFetchInternalError(ours), false, 'an assertion elsewhere still counts as a crash');
  assert.equal(isFetchInternalError(new TypeError('boom')), false);
  assert.equal(isFetchInternalError(undefined), false);
});

test('downloads and JSON calls: redirects, compressed responses, HTTP errors, user agent', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers['user-agent']);
    if (req.url === '/hop') return res.writeHead(302, { location: '/json' }).end();
    if (req.url === '/json') {
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
      return res.end(zlib.gzipSync(JSON.stringify({ ok: 'yes', list: [1, 2, 3] })));
    }
    if (req.url === '/file') return res.writeHead(200).end('#EXTM3U\nplain body\n');
    res.writeHead(404).end('nope');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iptvm-dl-'));
  try {
    assert.deepEqual(await fetchJson(`${base}/hop`, { userAgent: 'Agent/9' }), { ok: 'yes', list: [1, 2, 3] });
    assert.deepEqual(seen, ['Agent/9', 'Agent/9'], 'the user agent goes along with the redirect');
    const file = await download(`${base}/file`, path.join(dir, 'f.m3u'), {});
    assert.equal(fs.readFileSync(file, 'utf8'), '#EXTM3U\nplain body\n');
    await assert.rejects(fetchJson(`${base}/missing?username=me&password=secret`), /HTTP 404 .*password=\*\*\*/);
    await assert.rejects(download(`${base}/missing`, path.join(dir, 'x'), {}), /HTTP 404/);
    await assert.rejects(fetchJson('http://127.0.0.1:1/'), /ECONNREFUSED/);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('clientAddress believes X-Forwarded-For only through trusted proxies, read from the right', () => {
  const req = (socket, xff) => ({ socket: { remoteAddress: socket }, headers: xff ? { 'x-forwarded-for': xff } : {} });
  const local = trustedProxies('');
  // Through a proxy on the local network: the visitor is the proxy's last entry, not a forged one.
  assert.equal(clientAddress(req('::ffff:192.168.1.1', '1.2.3.4, 203.0.113.9'), local), '203.0.113.9');
  assert.equal(clientAddress(req('127.0.0.1', '192.168.1.50'), local), '192.168.1.50', 'a LAN visitor through the proxy');
  assert.equal(clientAddress(req('127.0.0.1'), local), '127.0.0.1');
  // Straight from the internet: the header is ignored.
  assert.equal(clientAddress(req('198.51.100.7', '10.0.0.1'), local), '198.51.100.7');
  // TRUSTED_PROXIES: none, or a list.
  assert.equal(clientAddress(req('192.168.1.1', '203.0.113.9'), trustedProxies('none')), '192.168.1.1');
  const listed = trustedProxies('203.0.113.0/24, 10.1.1.1');
  assert.equal(clientAddress(req('203.0.113.5', '8.8.8.8'), listed), '8.8.8.8');
  assert.equal(clientAddress(req('10.1.1.1', '8.8.4.4'), listed), '8.8.4.4');
  assert.equal(clientAddress(req('192.168.1.1', '8.8.8.8'), listed), '192.168.1.1', 'not on the list');
  assert.equal(clientAddress(req('::1', 'garbage, 2001:db8::5'), local), '2001:db8::5');
  for (const ip of ['10.2.3.4', '172.20.0.1', '192.168.0.9', '127.0.0.1', '::1', 'fd00::1', '::ffff:192.168.1.5']) assert.ok(isPrivateAddress(ip), ip);
  for (const ip of ['8.8.8.8', '172.32.0.1', '2001:db8::1', 'not an ip', '']) assert.ok(!isPrivateAddress(ip), ip);
});

test('Attempts blocks a key at its limit until the window passes; a success clears it', async () => {
  const a = new Attempts({ max: 3, windowMs: 80 });
  assert.deepEqual([a.fail('x'), a.fail('x'), a.blocked('x')], [false, false, false]);
  assert.equal(a.fail('x'), true, 'the one that reaches the limit says so');
  assert.equal(a.blocked('x'), true);
  assert.equal(a.blocked('y'), false);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(a.blocked('x'), false, 'until the window passes');
  a.fail('z');
  a.ok('z');
  assert.equal(a.map.has('z'), false);
});

test('TsProbe reads the codecs from the PAT and PMT, and judges what needs converting', async () => {
  const { tsStart } = await import('./ts.mjs');
  const probe = (tracks, split = 0) => {
    const bytes = Buffer.concat([Buffer.from([1, 2, 3]), tsStart(tracks)]); // a misaligned start
    const p = new TsProbe();
    if (!split) return p.push(bytes);
    let r = null;
    for (let i = 0; i < bytes.length && !r; i += split) r = p.push(bytes.subarray(i, i + split));
    return r;
  };
  assert.deepEqual(probe([{ type: 0x02 }, { type: 0x81 }]), { video: 'mpeg2', audio: 'ac3', convert: true }, 'an ATSC tuner channel');
  assert.deepEqual(probe([{ type: 0x1b }, { type: 0x0f }], 61), { video: 'h264', audio: 'aac', convert: false }, 'read across small chunks');
  assert.deepEqual(probe([{ type: 0x1b }, { type: 0x06, descriptors: [0x6a, 1, 0] }]), { video: 'h264', audio: 'ac3', convert: true }, 'DVB Dolby');
  assert.deepEqual(probe([{ type: 0x24 }, { type: 0x0f }]), { video: 'hevc', audio: 'aac', convert: false });
  assert.deepEqual(probe([{ type: 0x1b }, { type: 0x03 }]), { video: 'h264', audio: 'mp2', convert: true }, 'MPEG audio');
  assert.deepEqual(probe([{ type: 0x03 }]), { video: null, audio: 'mp2', convert: false }, 'radio is left alone');
  assert.deepEqual(probe([{ type: 0x1b }]), { video: 'h264', audio: null, convert: false });
  assert.equal(new TsProbe().push(Buffer.from('not a transport stream at all, just text '.repeat(40))), null);
});

test('behindOf: what a joiner was handed as its cushion is not lag, until it has gone', () => {
  const res = { writableLength: 12_000_000, iptvmReplay: 12_000_000 };
  assert.equal(behindOf(res), 0, 'all of it is the replayed cushion');
  res.writableLength = 13_000_000; // a new chunk queued behind it
  assert.equal(behindOf(res), 1_000_000);
  res.writableLength = 3_000_000; // the cushion is mostly sent: what's left of it is at the front
  assert.equal(behindOf(res), 0);
  assert.equal(res.iptvmReplay, 3_000_000);
  res.writableLength = 5_000_000;
  assert.equal(behindOf(res), 2_000_000);
  assert.equal(behindOf({ writableLength: 700 }), 700, 'a viewer that got no cushion');
  assert.equal(behindOf(null), 0);
});
