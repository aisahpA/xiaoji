import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
const root = path.resolve(import.meta.dirname, '..');
const readJson = async file => JSON.parse(await fs.readFile(path.join(root, file), 'utf8'));
const manifest = await readJson('manifest.json');
const pkg = await readJson('package.json');
const lock = await readJson('package-lock.json');
const versions = await readJson('versions.json');
if (pkg.version !== manifest.version || pkg.version !== lock.version || pkg.version !== lock.packages?.['']?.version || versions[pkg.version] !== manifest.minAppVersion) throw Error('Version metadata does not agree');
const files = ['main.js', 'manifest.json', 'styles.css'];
const chunks = [], directory = [], hashes = {};
let offset = 0;
const crc32 = bytes => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
};
for (const file of files) {
  const data = await fs.readFile(path.join(root, file));
  if (!data.length) throw Error('Empty runtime file: ' + file);
  if (file === 'main.js' && /sourceMappingURL=/.test(data.toString())) throw Error('Source map found in production bundle');
  const name = Buffer.from('xiaoji/' + file);
  const compressed = deflateRawSync(data);
  const crc = crc32(data);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
  header.writeUInt16LE(8, 8); header.writeUInt16LE(33, 12); header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x800, 8); central.writeUInt16LE(8, 10); central.writeUInt16LE(33, 14);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
  chunks.push(header, name, compressed); directory.push(central, name);
  offset += header.length + name.length + compressed.length;
  if (!inflateRawSync(compressed).equals(data)) throw Error('Archive roundtrip failed');
  hashes[file] = { bytes: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') };
}
const centralBytes = Buffer.concat(directory);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16);
const archive = Buffer.concat([...chunks, centralBytes, end]);
const destination = path.join(root, 'dist'); await fs.mkdir(destination, { recursive: true });
const name = 'xiaoji-' + pkg.version + '.zip';
await fs.writeFile(path.join(destination, name), archive);
const report = { version: pkg.version, archive: name, files: hashes, sha256: crypto.createHash('sha256').update(archive).digest('hex') };
await fs.writeFile(path.join(destination, 'checksums.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
