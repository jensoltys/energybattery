// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Energy Battery authors. See LICENSE.
// A real SQLite database built from schema.sql, wrapped in a small D1-shaped
// adapter, so the tests run the Worker's actual SQL.
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = readFileSync(new URL('../../schema.sql', import.meta.url), 'utf8');

export function d1(db) {
  const exec = (q, args) => (/^\s*select/i.test(q)
    ? { results: db.prepare(q).all(...args) }
    : (/\breturning\b/i.test(q)
      ? { results: db.prepare(q).all(...args), meta: { changes: 1 } }
      : { results: [], meta: { changes: Number(db.prepare(q).run(...args).changes) } }));
  return {
    prepare(q) {
      let args = [];
      const stmt = {
        bind(...a) { args = a; return stmt; },
        async first() { return db.prepare(q).get(...args) ?? null; },
        async all() { return { results: db.prepare(q).all(...args) }; },
        async run() { return exec(q, args); },
        _exec() { return exec(q, args); },
      };
      return stmt;
    },
    // Like D1: the whole batch runs as one unit, with no other request in between.
    async batch(stmts) { return stmts.map(st => st._exec()); },
  };
}

export function freshEnv(extra = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  return { env: { DB: d1(db), JWT_SECRET: 'test-secret-test-secret-test-secret-1234', ...extra }, db };
}

// Same shape the Worker stores: pbkdf2:<salt hex>:<hash hex>, 100k rounds.
export async function pbkdf2(pw) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: new Uint8Array(16), iterations: 100000, hash: 'SHA-256' }, key, 256);
  return `pbkdf2:${'00'.repeat(16)}:${Buffer.from(bits).toString('hex')}`;
}
