const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const source = path.join(process.env.APPDATA, 'Paper Timeline', 'library');
const target = path.resolve(__dirname, '..', 'library');
if (fs.existsSync(target)) throw new Error('The project library already exists; no files were overwritten.');
if (!fs.existsSync(path.join(source, 'library.json'))) throw new Error('No previous library was found.');
const snapshot = fs.readFileSync(path.join(source, 'library.json'));
const library = JSON.parse(snapshot.toString('utf8'));
if (library.version !== 1 || !Array.isArray(library.papers)) throw new Error('Invalid source library.');
for (const paper of library.papers) {
  if (!/^[a-f0-9]{64}$/.test(paper.id)) throw new Error('Invalid PDF identifier.');
  if (paper.pdfHash === null) continue;
  const hash = paper.pdfHash === undefined ? paper.id : paper.pdfHash;
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid PDF hash.');
  const bytes = fs.readFileSync(path.join(source, 'pdfs', `${hash}.pdf`));
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error(`Source PDF checksum mismatch: ${paper.fileName}`);
}
fs.cpSync(source, target, { recursive: true, force: false, errorOnExist: true });
if (!fs.readFileSync(path.join(target, 'library.json')).equals(snapshot)) throw new Error('Library changed during copying; please close the app before migrating.');
for (const paper of library.papers) {
  if (paper.pdfHash === null) continue;
  const hash = paper.pdfHash === undefined ? paper.id : paper.pdfHash;
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid PDF hash.');
  const bytes = fs.readFileSync(path.join(target, 'pdfs', `${hash}.pdf`));
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error(`Copied PDF checksum mismatch: ${paper.fileName}`);
}
console.log(JSON.stringify({ target, papers: library.papers.length, pdfChecksums: 'verified', originalLibrary: 'preserved' }, null, 2));
