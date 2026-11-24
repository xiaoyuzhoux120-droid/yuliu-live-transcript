// UI/UX regression smoke test for the transcript workspace (no microphone, no network, no API keys).
// Usage: node tests/ux/workspace-ux.e2e.mjs   (requires the `playwright` package and a Chromium build)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
// Resolve Playwright from the project or a global install (it is not a project dependency).
const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const server = http.createServer((req, res) => {
  const script = req.url.match(/^\/([\w-]+\.js)/);
  const file = script ? path.join(root, 'public', script[1]) : path.join(root, 'app', 'app', 'transcript.html');
  res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(file));
});
const results = [];
const check = (name, ok, extra='') => { results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };
(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const URL = `http://127.0.0.1:${server.address().port}/`;
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  await p.goto(URL);
  // 1. demo
  await p.click('#demoBtn');
  await p.waitForFunction(() => !recording && lines.length === 3, null, { timeout: 10000 });
  check('demo produces 3 lines', true);
  check('demo session not saved to history', (await p.evaluate(() => readHistory().length)) === 0);
  // 2. real-ish session: mock recording by injecting lines while "recording"
  await p.evaluate(() => { startNewSession({ force: true }); recognitionMode = 'browser'; startSession('mock'); });
  await p.evaluate(async () => { await addLine('第一句：我们先过一下季度目标。'); await addLine('Second line about the roadmap and budget.', '', 2); });
  await p.waitForTimeout(1200);
  await p.evaluate(() => stopRecording());
  // continue recording: timestamps should continue, not restart at 00:00
  await p.evaluate(() => { elapsedOffset = 125000; recognitionMode = 'browser'; startSession('mock'); });
  await p.evaluate(async () => { await addLine('继续录音后的第三句。'); });
  const thirdTime = await p.evaluate(() => lines[2].time);
  check('Record again continues timeline', thirdTime === '02:05', `third line time=${thirdTime}`);
  await p.evaluate(() => stopRecording());
  await p.waitForTimeout(300);
  check('session auto-saved to history', (await p.evaluate(() => readHistory().length)) === 1);
  // 3. search
  await p.fill('#searchInput', 'roadmap');
  await p.waitForTimeout(100);
  const marks = await p.locator('#transcript mark').count();
  check('search highlights match', marks === 1, `marks=${marks}, label=${await p.textContent('#searchCount')}`);
  await p.fill('#searchInput', '');
  // 4. star + edit
  await p.hover('#transcript > .line:nth-child(1)');
  await p.click('#transcript > .line:nth-child(1) [data-action=star]');
  check('star line', await p.evaluate(() => lines[0].starred));
  await p.click('#transcript > .line:nth-child(2) [data-action=edit]');
  await p.keyboard.press('Control+A');
  await p.keyboard.type('Second line about the product roadmap.');
  await p.keyboard.press('Enter');
  const edited = await p.evaluate(() => [lines[1].text, lines[1].edited]);
  check('inline edit saves text', edited[0] === 'Second line about the product roadmap.' && edited[1], JSON.stringify(edited));
  // 5. rename speaker
  await p.dblclick('[data-speaker="2"]');
  await p.keyboard.press('Control+A');
  await p.keyboard.type('Alice');
  await p.keyboard.press('Enter');
  const badge = await p.textContent('#transcript > .line:nth-child(2) .speaker-badge');
  check('rename speaker updates transcript', badge === 'Alice', badge);
  // 6. scene preset
  await p.selectOption('#sceneSelect', 'class');
  const b1 = await p.textContent('#transcript > .line:nth-child(1) .speaker-badge');
  check('class scene labels speaker 1 as 老师', b1 === '老师', b1);
  // 7. exports
  const [dl] = await Promise.all([p.waitForEvent('download'), (async () => { await p.click('#exportBtn'); await p.click('[data-export=md]'); })()]);
  const md = fs.readFileSync(await dl.path(), 'utf8');
  check('markdown export has key moments + transcript', md.includes('## 重点标记') && md.includes('## 完整转写') && md.includes('Alice'), dl.suggestedFilename());
  const [dl2] = await Promise.all([p.waitForEvent('download'), (async () => { await p.click('#exportBtn'); await p.click('[data-export=srt]'); })()]);
  const srt = fs.readFileSync(await dl2.path(), 'utf8');
  check('srt export well-formed', /^1\n00:00:0\d,000 --> 00:\d\d:\d\d,000\n/.test(srt) && srt.includes('00:02:05,000'), srt.split('\n').slice(0,3).join(' | '));
  // 8. history persists across reload
  await p.waitForTimeout(1700);
  await p.reload();
  const hist = await p.evaluate(() => readHistory()[0]);
  check('history survives reload', hist && hist.lines.length === 3 && hist.speakerNames['2'] === 'Alice' && hist.lines[0].starred);
  await p.click('#historyBtn');
  await p.waitForTimeout(200);
  await p.click('[data-history=open]');
  check('open session from history', (await p.evaluate(() => lines.length)) === 3 && (await p.textContent('#timer')) !== '00:00', await p.textContent('#timer'));
  await p.waitForTimeout(400);
  // 9. demo does not wipe a real transcript without saving
  await p.click('#demoBtn');
  await p.waitForFunction(() => !recording && lines.length === 3 && isDemoSession, null, { timeout: 10000 });
  check('demo after real session keeps real session in history', (await p.evaluate(() => readHistory().length)) === 1);
  // 10. captions
  await p.keyboard.press('c');
  await p.waitForTimeout(300);
  check('caption mode opens with C', await p.isVisible('#captionView'));
  await p.keyboard.press('Escape');
  check('Esc closes captions', !(await p.isVisible('#captionView')));
  // 11. scroll: user scrolled up should not be yanked to bottom
  await p.evaluate(async () => { startNewSession({ force: true }); recognitionMode='browser'; startSession('mock'); for (let i = 0; i < 40; i++) await addLine(`第 ${i} 句，测试长会议滚动行为，内容足够长以便换行显示。`); });
  await p.evaluate(() => { $('#transcript').scrollTop = 0; });
  await p.evaluate(async () => { setInterim('正在说的话'); await addLine('新的一句'); });
  const st = await p.evaluate(() => [$('#transcript').scrollTop, $('#jumpLatest').hidden]);
  check('scrolled-up reader is not yanked to bottom; jump pill shown', st[0] === 0 && st[1] === false, JSON.stringify(st));
  // 12. perf: 2000 lines, interim updates
  const perf = await p.evaluate(async () => {
    for (let i = 0; i < 2000; i++) lines.push({ id: 'p' + i, time: '10:00', at: 600, text: '这是一个用于性能测试的长句子，模拟两小时会议的转写内容。', translation: 'This is a long sentence for performance testing.', speaker: 1 + (i % 3), starred: false, edited: false, rev: 0 });
    render();
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) setInterim('临时识别结果 ' + i); // interim updates only touch the interim row
    return (performance.now() - t0) / 100;
  });
  check('interim update cost with 2,000 lines', perf < 8, `${perf.toFixed(2)} ms/update`);
  await p.evaluate(() => stopRecording());
  check('no page errors', errors.length === 0, errors.join('; '));
  // mobile
  const m = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  await m.goto(URL);
  await m.click('#demoBtn');
  await m.waitForTimeout(6000);
  const overflow = await m.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  check('mobile: no horizontal overflow', !overflow);
  console.log(results.join('\n'));
  await b.close();
  server.close();
  if (results.some((line) => line.startsWith('FAIL'))) process.exit(1);
})().catch((error) => { console.error(error); server.close(); process.exit(1); });
