import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { crc32 } from '../server/transport/rgba.js';
import { validateImage } from '../server/image-validation.js';

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function chunk(type, payload = Buffer.alloc(0)) {
  const tag = Buffer.isBuffer(type) ? type : Buffer.from(type);
  const result = Buffer.alloc(payload.length + 12);
  result.writeUInt32BE(payload.length); tag.copy(result, 4); payload.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([tag, payload])), payload.length + 8);
  return result;
}
function header({ width = 1, height = 1, depth = 8, color = 6, interlace = 0 } = {}) {
  const result = Buffer.alloc(13);
  result.writeUInt32BE(width); result.writeUInt32BE(height, 4);
  result[8] = depth; result[9] = color; result[12] = interlace;
  return result;
}
function png({ width = 1, height = 1, depth = 8, color = 6, interlace = 0,
  raster, before = [], after = [], compressed } = {}) {
  const channels = new Map([[0, 1], [2, 3], [3, 1], [4, 2], [6, 4]]).get(color) || 1;
  const expected = height * (1 + Math.ceil(width * channels * depth / 8));
  const bytes = raster || Buffer.alloc(Math.min(expected, 65536));
  return Buffer.concat([signature, chunk('IHDR', header({ width, height, depth, color, interlace })),
    ...before, chunk('IDAT', compressed || deflateSync(bytes)), ...after, chunk('IEND')]);
}

// Real small baseline and progressive fixtures generated locally with installed Pillow;
// tests use their static bytes and do not need Pillow, a renderer, or an external service.
const baseline = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDyOiiiuw5D/9k=', 'base64');
const progressive = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wgARCAADAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUAQEAAAAAAAAAAAAAAAAAAAAD/9oADAMBAAIQAxAAAAGRDD//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAn//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/AX//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/AX//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/An//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IX//2gAMAwEAAgADAAAAEAf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EH//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EH//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EH//2Q==', 'base64');
const markerAt = (image, code) => image.indexOf(Buffer.from([255, code]));
function mutateJpeg(code, mutate) {
  const image = Buffer.from(baseline), position = markerAt(image, code);
  assert.ok(position >= 0);
  mutate(image, position);
  return image;
}

test('valid noninterlaced PNG modes and packed low-bit scanlines are structurally accepted', () => {
  for (const [color, depths] of [[0, [1, 2, 4, 8, 16]], [2, [8, 16]], [3, [1, 2, 4, 8]], [4, [8, 16]], [6, [8, 16]]]) {
    for (const depth of depths) {
      const before = color === 3 ? [chunk('PLTE', Buffer.from([0, 0, 0, 255, 255, 255]))] : [];
      assert.deepEqual(validateImage(png({ width: 3, height: 2, depth, color, before }), 'image/png'),
        { width: 3, height: 2, format: 'png' });
    }
  }
  assert.deepEqual(validateImage(png({ width: 8192 }), 'image/png'), { width: 8192, height: 1, format: 'png' });
});

test('PNG permits legal filters, contiguous split IDAT and ordinary ancillary chunks', () => {
  for (let filter = 0; filter <= 4; filter++) {
    assert.equal(validateImage(png({ raster: Buffer.from([filter, 0, 0, 0, 255]) }), 'image/png').width, 1);
  }
  const compressed = deflateSync(Buffer.from([0, 0, 0, 0, 255]));
  const image = Buffer.concat([signature, chunk('IHDR', header()), chunk('tEXt', Buffer.from('note\0local fixture')),
    chunk('IDAT', compressed.subarray(0, 3)), chunk('IDAT', compressed.subarray(3)), chunk('IEND')]);
  assert.equal(validateImage(image, 'image/png').height, 1);
});

test('PNG rejects signature-only, truncation, CRC corruption and trailing bytes', () => {
  const image = png();
  for (const incomplete of [signature, image.subarray(0, 20), image.subarray(0, -1)]) {
    assert.throws(() => validateImage(incomplete, 'image/png'), /PNG/);
  }
  const badCrc = Buffer.from(image); badCrc[29] ^= 1;
  assert.throws(() => validateImage(badCrc, 'image/png'), /CRC/);
  assert.throws(() => validateImage(Buffer.concat([image, Buffer.from('extra')]), 'image/png'), /IEND/);
});

test('PNG enforces dimensions, pixel budget, raster budget, color/depth and no interlace', () => {
  for (const options of [{ width: 0 }, { height: 0 }, { width: 8193 }, { height: 8193 },
    { width: 4001, height: 4000 }, { width: 4000, height: 4000, depth: 16 },
    { depth: 4, color: 6 }, { depth: 3, color: 0 }, { color: 5 }, { interlace: 1 }]) {
    assert.throws(() => validateImage(png(options), 'image/png'), /dimensions|raster|mode|Interlaced/);
  }
});

test('PNG rejects malformed order, duplicate headers, missing data, APNG and unknown critical chunks', () => {
  assert.throws(() => validateImage(Buffer.concat([signature, chunk('IDAT'), chunk('IEND')]), 'image/png'), /IHDR/);
  assert.throws(() => validateImage(png({ before: [chunk('IHDR', header())] }), 'image/png'), /IHDR/);
  assert.throws(() => validateImage(Buffer.concat([signature, chunk('IHDR', header()), chunk('IEND')]), 'image/png'), /IEND|IDAT/);
  for (const type of ['acTL', 'fcTL', 'fdAT', 'ABCD']) {
    assert.throws(() => validateImage(png({ before: [chunk(type)] }), 'image/png'), /Animated|critical/);
  }
  const compressed = deflateSync(Buffer.alloc(5));
  const interleaved = Buffer.concat([signature, chunk('IHDR', header()), chunk('IDAT', compressed.subarray(0, 2)),
    chunk('tEXt'), chunk('IDAT', compressed.subarray(2)), chunk('IEND')]);
  assert.throws(() => validateImage(interleaved, 'image/png'), /IDAT/);
});

test('PNG rejects high-bit chunk aliases, oversized lengths and invalid palette constraints', () => {
  const alias = Buffer.from('IHDR').map(byte => byte | 128);
  assert.throws(() => validateImage(Buffer.concat([signature, chunk(alias, header()), chunk('IEND')]), 'image/png'), /chunk type/);
  const length = Buffer.from(png()); length.writeUInt32BE(0xffffffff, 8);
  assert.throws(() => validateImage(length, 'image/png'), /Truncated/);
  assert.throws(() => validateImage(png({ color: 3 }), 'image/png'), /palette/);
  assert.throws(() => validateImage(png({ color: 3, depth: 1, before: [chunk('PLTE', Buffer.alloc(9))] }), 'image/png'), /palette/);
  assert.throws(() => validateImage(png({ color: 0, before: [chunk('PLTE', Buffer.alloc(3))] }), 'image/png'), /palette/);
});

test('PNG bounds inflate output and rejects truncated streams, trailing zlib junk and wrong filter/length', () => {
  assert.throws(() => validateImage(png({ compressed: deflateSync(Buffer.alloc(1024 * 1024)) }), 'image/png'), /raster/);
  const compressed = deflateSync(Buffer.alloc(5));
  assert.throws(() => validateImage(png({ compressed: compressed.subarray(0, -1) }), 'image/png'), /raster/);
  assert.throws(() => validateImage(png({ compressed: Buffer.concat([compressed, Buffer.from('junk')]) }), 'image/png'), /Trailing/);
  assert.throws(() => validateImage(png({ raster: Buffer.alloc(4) }), 'image/png'), /length/);
  assert.throws(() => validateImage(png({ raster: Buffer.from([5, 0, 0, 0, 0]) }), 'image/png'), /filter byte/);
});

test('real small baseline and progressive JPEG fixtures expose bounded dimensions', () => {
  assert.deepEqual(validateImage(baseline, 'image/jpeg'), { width: 1, height: 1, format: 'jpeg' });
  assert.deepEqual(validateImage(progressive, 'image/jpeg'), { width: 2, height: 3, format: 'jpeg' });
  const fill = Buffer.concat([baseline.subarray(0, 2), Buffer.from([255]), baseline.subarray(2)]);
  assert.equal(validateImage(fill, 'image/jpeg').width, 1);
});

test('JPEG rejects signature-only, truncated segments/scans, missing EOI and trailing bytes', () => {
  for (const image of [Buffer.from([255, 216, 255]), baseline.subarray(0, 20), baseline.subarray(0, -1), baseline.subarray(0, -2)]) {
    assert.throws(() => validateImage(image, 'image/jpeg'), /JPEG/);
  }
  assert.throws(() => validateImage(Buffer.concat([baseline, Buffer.from('extra')]), 'image/jpeg'), /EOI/);
  assert.throws(() => validateImage(mutateJpeg(0xe0, (data, position) => data.writeUInt16BE(65535, position + 2)), 'image/jpeg'), /segment/);
  assert.throws(() => validateImage(mutateJpeg(0xe0, (data, position) => data.writeUInt16BE(1, position + 2)), 'image/jpeg'), /segment/);
});

test('JPEG rejects oversized or zero SOF dimensions and malformed component metadata', () => {
  for (const mutate of [
    (data, position) => data.writeUInt16BE(0, position + 5),
    (data, position) => data.writeUInt16BE(8193, position + 7),
    (data, position) => { data.writeUInt16BE(4001, position + 7); data.writeUInt16BE(4000, position + 5); },
    (data, position) => { data[position + 9] = 0; },
    (data, position) => { data[position + 11] = 0; },
    (data, position) => { data[position + 4] = 16; },
  ]) assert.throws(() => validateImage(mutateJpeg(0xc0, mutate), 'image/jpeg'), /dimensions|frame/);
});

test('JPEG requires one supported SOF, real scan framing and referenced component tables', () => {
  const sof = markerAt(baseline, 0xc0), sofEnd = sof + 2 + baseline.readUInt16BE(sof + 2);
  assert.throws(() => validateImage(Buffer.concat([baseline.subarray(0, sof), baseline.subarray(sofEnd)]), 'image/jpeg'), /SOF/);
  assert.throws(() => validateImage(Buffer.concat([baseline.subarray(0, sofEnd), baseline.subarray(sof, sofEnd), baseline.subarray(sofEnd)]), 'image/jpeg'), /SOF/);
  assert.throws(() => validateImage(mutateJpeg(0xc0, (data, position) => { data[position + 1] = 0xc3; }), 'image/jpeg'), /Unsupported/);
  const sos = markerAt(baseline, 0xda), entropy = sos + 2 + baseline.readUInt16BE(sos + 2);
  assert.throws(() => validateImage(Buffer.concat([baseline.subarray(0, entropy), Buffer.from([255, 217])]), 'image/jpeg'), /Empty/);
  assert.throws(() => validateImage(mutateJpeg(0xda, (data, position) => { data[position + 5] = 99; }), 'image/jpeg'), /component/);
  assert.throws(() => validateImage(mutateJpeg(0xdb, (data, position) => { data[position + 5] = 0; }), 'image/jpeg'), /quantization/);
  assert.throws(() => validateImage(mutateJpeg(0xc4, (data, position) => data.writeUInt16BE(3, position + 2)), 'image/jpeg'), /Huffman/);
});

test('JPEG rejects malformed restart markers and standalone SOI within the image', () => {
  const misplacedRestart = Buffer.concat([baseline.subarray(0, -2), Buffer.from([255, 208]), baseline.subarray(-2)]);
  assert.throws(() => validateImage(misplacedRestart, 'image/jpeg'), /restart/);
  const duplicateSoi = Buffer.concat([baseline.subarray(0, 2), Buffer.from([255, 216]), baseline.subarray(2)]);
  assert.throws(() => validateImage(duplicateSoi, 'image/jpeg'), /standalone/);
});

test('MIME signatures, byte input and 4 MiB container bounds are enforced', () => {
  assert.throws(() => validateImage(baseline, 'image/png'), /signature/);
  assert.throws(() => validateImage(png(), 'image/jpeg'), /signature/);
  assert.throws(() => validateImage(png(), 'image/gif'), /MIME/);
  assert.throws(() => validateImage('not bytes', 'image/png'), /bytes/);
  assert.throws(() => validateImage(Buffer.alloc(0), 'image/png'), /size/);
  assert.throws(() => validateImage(Buffer.alloc(4 * 1024 * 1024 + 1), 'image/png'), /size/);
});
