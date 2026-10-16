import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Explicit allowlist: do not copy server config, schema or any reader-private files.
const output = new URL('../dist/api/', import.meta.url);
await fs.mkdir(output, { recursive: true });
for (const name of ['index.php', 'contract.php', '.htaccess']) {
  await fs.copyFile(new URL('../server/api/' + name, import.meta.url), new URL(name, output));
}
// The original cloud books are build inputs, not deployment payloads. The
// reader consumes only generated .chunks groups; this avoids re-downloading a
// full EPUB/TXT from a phone and keeps copyrighted source files out of dist.
const books = new URL('../dist/books/', import.meta.url);
const booksPath = fileURLToPath(books);
for (const item of await fs.readdir(books, { withFileTypes: true })) {
  if (item.name !== '.chunks') await fs.rm(path.join(booksPath, item.name), { recursive: true, force: true });
}
console.log('已打包 PHP 同步接口（不含数据库配置）');
