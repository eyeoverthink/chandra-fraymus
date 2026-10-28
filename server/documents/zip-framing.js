// yauzl validates each advertised entry but stops at the EOCD count. Verify the
// complete directory and local-record extent first, so hidden/unconsumed records
// cannot masquerade as a fully checked archive. ZIP64/multidisk/SFX are unsupported.
export function validateZipFraming(data, maxEntries = 500) {
  if (data.length < 22) throw new Error('Truncated ZIP directory');
  let eocd = -1;
  for (let position = data.length - 22; position >= Math.max(0, data.length - 65557); position--) {
    if (data.readUInt32LE(position) === 0x06054b50 && position + 22 + data.readUInt16LE(position + 20) === data.length) { eocd = position; break; }
  }
  if (eocd < 0) throw new Error('ZIP end directory was not found');
  const count = data.readUInt16LE(eocd + 10), size = data.readUInt32LE(eocd + 12), start = data.readUInt32LE(eocd + 16);
  if (count === 0xffff || size === 0xffffffff || start === 0xffffffff) throw new Error('ZIP64 is unsupported');
  if (data.readUInt16LE(eocd + 4) || data.readUInt16LE(eocd + 6) || data.readUInt16LE(eocd + 8) !== count) throw new Error('Multi-disk ZIP is unsupported');
  if (count > maxEntries) throw new Error('ZIP exceeds 500 entries');
  if (start + size !== eocd) throw new Error('ZIP central directory extent is inconsistent');
  function extras(position, length) {
    const end = position + length;
    while (position < end) {
      if (position + 4 > end) throw new Error('Truncated ZIP extra field');
      const tag = data.readUInt16LE(position), bytes = data.readUInt16LE(position + 2);
      if (tag === 1) throw new Error('ZIP64 is unsupported');
      position += 4 + bytes;
      if (position > end) throw new Error('Truncated ZIP extra field');
    }
  }
  let position = start;
  const records = [];
  for (let number = 0; number < count; number++) {
    if (position + 46 > eocd || data.readUInt32LE(position) !== 0x02014b50) throw new Error('ZIP central directory count/framing mismatch');
    const nameLength = data.readUInt16LE(position + 28), extraLength = data.readUInt16LE(position + 30), commentLength = data.readUInt16LE(position + 32);
    const end = position + 46 + nameLength + extraLength + commentLength;
    if (end > eocd || data.readUInt16LE(position + 34)) throw new Error('Invalid ZIP central record extent or disk');
    extras(position + 46 + nameLength, extraLength);
    const local = data.readUInt32LE(position + 42), compressed = data.readUInt32LE(position + 20), expanded = data.readUInt32LE(position + 24);
    if (local === 0xffffffff || compressed === 0xffffffff || expanded === 0xffffffff) throw new Error('ZIP64 is unsupported');
    if (local + 30 > start || data.readUInt32LE(local) !== 0x04034b50) throw new Error('ZIP local header is missing or overlaps its directory');
    const flags = data.readUInt16LE(position + 8), method = data.readUInt16LE(position + 10), crc = data.readUInt32LE(position + 16);
    const localName = data.readUInt16LE(local + 26), localExtra = data.readUInt16LE(local + 28);
    const payload = local + 30 + localName + localExtra;
    if (payload + compressed > start || localName !== nameLength || flags !== data.readUInt16LE(local + 6) || method !== data.readUInt16LE(local + 8)
      || !data.subarray(position + 46, position + 46 + nameLength).equals(data.subarray(local + 30, local + 30 + localName))) throw new Error('ZIP local and central headers disagree');
    extras(local + 30 + localName, localExtra);
    let recordEnd = payload + compressed;
    if (flags & 8) {
      if (recordEnd + 12 > start) throw new Error('Truncated ZIP data descriptor');
      const descriptor = data.readUInt32LE(recordEnd) === 0x08074b50 ? recordEnd + 4 : recordEnd;
      if (descriptor + 12 > start || data.readUInt32LE(descriptor) !== crc || data.readUInt32LE(descriptor + 4) !== compressed || data.readUInt32LE(descriptor + 8) !== expanded) throw new Error('ZIP data descriptor disagrees with its directory');
      recordEnd = descriptor + 12;
    } else if (data.readUInt32LE(local + 14) !== crc || data.readUInt32LE(local + 18) !== compressed || data.readUInt32LE(local + 22) !== expanded) throw new Error('ZIP local and central sizes/CRC disagree');
    records.push({ start: local, end: recordEnd }); position = end;
  }
  if (position !== eocd) throw new Error('ZIP directory contains unconsumed records');
  let next = 0;
  for (const record of records.sort((a, b) => a.start - b.start)) {
    if (record.start !== next) throw new Error('ZIP has unindexed or overlapping local records');
    next = record.end;
  }
  if (next !== start) throw new Error('ZIP local records do not cover the declared archive extent');
  return { count };
}
