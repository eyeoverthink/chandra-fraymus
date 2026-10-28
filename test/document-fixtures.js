import { deflateRawSync } from 'node:zlib';
import { crc32 } from '../server/transport/rgba.js';

export function pdfFixture(pages = ['First page needle', 'Second page evidence']) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  for (let i = 0; i < pages.length; i++) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    const lines = pages[i].split('\n').map(line => `(${line.replace(/[\\()]/g, '\\$&')}) Tj T*`).join('\n');
    const stream = `BT /F1 10 Tf 12 TL 50 740 Td ${lines} ET`;
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  let result = '%PDF-1.7\n';
  const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(result)); result += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(result);
  result += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  result += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  result += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(result);
}

export function zipFixture(files) {
  const locals = [], central = []; let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name), bytes = Buffer.isBuffer(file.text) ? file.text : Buffer.from(file.text ?? 'sample');
    const payload = Buffer.concat([file.deflate ? deflateRawSync(bytes) : bytes, file.trailing || Buffer.alloc(0)]);
    const crc = file.crc ?? crc32(bytes), method = file.method ?? (file.deflate ? 8 : 0), flags = file.flags ?? 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(payload.length, 18); local.writeUInt32LE(file.size ?? bytes.length, 22); local.writeUInt16LE(name.length, 26);
    locals.push(local, name, payload);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50); header.writeUInt16LE(0x0314, 4); header.writeUInt16LE(20, 6); header.writeUInt16LE(flags, 8); header.writeUInt16LE(method, 10);
    header.writeUInt32LE(crc, 16); header.writeUInt32LE(payload.length, 20); header.writeUInt32LE(file.size ?? bytes.length, 24); header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(file.attributes ?? 0, 38); header.writeUInt32LE(offset, 42);
    central.push(header, name); offset += local.length + name.length + payload.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
