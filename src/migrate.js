// Traslado a otro servidor: exporta la base de datos y los archivos (audios, fotos) en un solo paquete.
// Formato: gzip de bloques "{"name":"…","size":N}\n" + N bytes.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { config } from './config.js';
import * as db from './db.js';
import { MEDIA_DIR } from './media.js';

export function buildExport() {
  const tmp = path.join(config.dataDir, `export-${Date.now()}.db`);
  db.db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`); // copia consistente aunque el servidor siga funcionando
  try {
    const files = [['wa.db', tmp], ...fs.readdirSync(MEDIA_DIR).filter((f) => fs.statSync(path.join(MEDIA_DIR, f)).isFile()).map((f) => [`media/${f}`, path.join(MEDIA_DIR, f)])];
    const parts = [];
    for (const [name, full] of files) {
      const buf = fs.readFileSync(full);
      parts.push(Buffer.from(JSON.stringify({ name, size: buf.length }) + '\n'), buf);
    }
    return { gz: zlib.gzipSync(Buffer.concat(parts), { level: 1 }), count: files.length };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// Las tareas automáticas (sincronizar Shopify, recordatorios, avisos de envío) se pausan en el servidor viejo
// después de exportar, para que los dos servidores no le escriban dos veces a la misma clienta.
export const jobsPaused = () => db.getSetting('jobs_paused') === '1';
export const setJobsPaused = (v) => db.setSetting('jobs_paused', v ? '1' : '0');
