import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { seamScore, greyEnds, lastFramePng, fitExtension, joinContinuation, frameRate, probe } from '../server/media/looks/convert.js';

const ff = args => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);

test('the seam score: a continuation is ordinary motion, a cut is not', () => {
  const frame = v => Uint8Array.from({ length: 96 * 54 }, (_, i) => (i + v) % 256);
  const steady = [0, 2, 4, 6].map(frame);
  assert.equal(seamScore(steady, [8, 10, 12].map(frame)).ok, true);
  const other = [0, 1, 2].map(k => Uint8Array.from({ length: 96 * 54 }, (_, i) => (i * 7 + 128 + k) % 256));
  const cut = seamScore(steady, other);
  assert.equal(cut.ok, false); assert.ok(cut.seam > cut.limit);
  assert.equal(seamScore([], other).ok, false);
});

test('a clip continued from its own last frame passes; a cut to another picture fails; the join keeps sound and length', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chandra-extend-'));
  try {
    // one moving source cut in two: B is the true continuation of A. C is a different picture (a cut).
    const whole = join(dir, 'whole.mp4');
    ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', whole]);
    const a = join(dir, 'a.mp4'), b = join(dir, 'b.mp4'), c = join(dir, 'c.mp4');
    ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=2:sample_rate=44100', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', a]);
    // the "extension" a model would return: it starts ON A's last frame (frame 59 of the source), at another size and 24 fps
    ff(['-ss', '1.9667', '-i', whole, '-t', '2', '-vf', 'scale=960:544,fps=24', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', b]);
    ff(['-f', 'lavfi', '-i', 'mandelbrot=size=960x544:rate=24', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', c]);

    const last = lastFramePng(a, join(dir, 'last.png'));
    assert.ok((await last).length > 1000, 'the last frame is a picture');

    const info = await probe(a), fps = await frameRate(a);
    assert.equal(Math.round(fps), 30);
    const fitB = join(dir, 'b-fit.mp4'), fitC = join(dir, 'c-fit.mp4');
    await fitExtension(b, fitB, { w: info.w, h: info.h, fps });
    await fitExtension(c, fitC, { w: info.w, h: info.h, fps });
    const ends = await greyEnds(a);
    const good = seamScore(ends.tail, (await greyEnds(fitB)).head);
    const bad = seamScore(ends.tail, (await greyEnds(fitC)).head);
    assert.equal(good.ok, true, JSON.stringify(good));
    assert.equal(bad.ok, false, JSON.stringify(bad));
    assert.ok(bad.seam > 3 * good.seam, `a cut (${bad.seam}) jumps far more than a continuation (${good.seam})`);

    const fitted = await probe(fitB), joined = join(dir, 'joined.mp4');
    await joinContinuation(a, fitB, joined, { audio: true, extSeconds: fitted.seconds });
    const j = await probe(joined);
    assert.equal(j.audio, true);
    assert.deepEqual([j.w, j.h], [640, 360]);
    assert.ok(Math.abs(j.seconds - (2 + fitted.seconds)) < 0.15, `${j.seconds} s joined from 2 + ${fitted.seconds}`);
    // the first frame of the model's clip (the start picture it was given) is dropped: no frame is shown twice
    assert.ok(fitted.seconds < 2, `${fitted.seconds}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
