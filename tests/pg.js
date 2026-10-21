/*
 * Real PostgreSQL for the tests: PGlite (Postgres compiled to WebAssembly)
 * with supabase/setup.sql installed the way the Supabase SQL Editor runs it,
 * plus a small stand-in for PostgREST's POST /rest/v1/rpc/<fn> endpoint.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SETUP_SQL = path.resolve(__dirname, '..', 'supabase', 'setup.sql');

// Roles and default privileges as on Supabase. "app_owner" plays Supabase's
// "postgres" role, which is not a superuser and runs SQL Editor scripts.
const BOOTSTRAP = `
  set timezone = 'UTC';
  create role anon nologin noinherit;
  create role authenticated nologin noinherit;
  create role service_role nologin noinherit bypassrls;
  create role app_owner nologin createrole bypassrls;
  do $$ begin execute format('grant create on database %I to app_owner', current_database()); end $$;
  grant usage, create on schema public to app_owner;
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges for role app_owner in schema public grant all on tables    to anon, authenticated, service_role;
  alter default privileges for role app_owner in schema public grant all on functions to anon, authenticated, service_role;
  alter default privileges for role app_owner in schema public grant all on sequences to anon, authenticated, service_role;
`;

function loadPGlite() {
  try {
    return require('@electric-sql/pglite').PGlite;
  } catch (e) {
    throw new Error('PGlite is not installed. Run "npm install" in the tests folder. (' + e.message + ')');
  }
}

/** Run setup.sql (or other SQL) as the owner role, like the SQL Editor. */
async function install(db, sql) {
  await db.exec('set role app_owner');
  try {
    await db.exec(sql == null ? fs.readFileSync(SETUP_SQL, 'utf8') : sql);
  } finally {
    await db.exec('reset role');
  }
}

/** New in-memory database with the PastePort backend installed. */
async function openDb() {
  const PGlite = loadPGlite();
  const db = new PGlite();
  await db.waitReady;
  await db.exec(BOOTSTRAP);
  await install(db);
  return db;
}

// SQLSTATE -> HTTP status, as documented by PostgREST.
function httpStatus(code, role) {
  if (code === '42501') return role === 'anon' ? 401 : 403;
  if (code === 'P0001') return 400;
  if (code === '23503' || code === '23505') return 409;
  if (code === '25006') return 405;
  if (code === '42883' || code === '42P01') return 404;
  if (code === '42P17') return 500;
  const c = String(code).slice(0, 2);
  if (c === '08' || c === '53') return 503;
  if (c === '0L' || c === '0P' || c === '28') return 403;
  if (['09', '25', '2D', '38', '39', '3B', '40', '54', '55', '57', '58', 'F0', 'HV', 'P0', 'XX'].includes(c)) return 500;
  return 400;
}

const ident = (s) => '"' + String(s).replace(/"/g, '""') + '"';

/**
 * Calls public functions the way PostgREST does: named arguments taken from
 * the JSON body, one transaction per call with "set local role", and a
 * read-only transaction for STABLE/IMMUTABLE functions.
 */
class Rest {
  constructor(db) {
    this.db = db;
    this.funcs = null;
    this.queue = Promise.resolve();
  }

  serial(fn) {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => {});
    return run;
  }

  async loadSchema() {
    const r = await this.db.query(`
      select p.proname as name, p.provolatile as vol, p.pronargdefaults as ndef,
             coalesce(p.proargnames, '{}'::text[]) as argnames,
             array(select format_type(t.oid, null)
                     from unnest(p.proargtypes::oid[]) with ordinality as t(oid, ord)
                    order by t.ord) as argtypes
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prokind = 'f'`);
    this.funcs = new Map(r.rows.map((row) => [row.name, row]));
  }

  call(fn, args, role) {
    return this.serial(() => this._call(fn, args || {}, role || 'anon'));
  }

  async _call(fn, args, role) {
    if (!this.funcs) await this.loadSchema();
    const f = this.funcs.get(fn);
    const keys = Object.keys(args);
    const params = f ? f.argnames.map((name, i) => ({ name, type: f.argtypes[i], required: i < f.argnames.length - f.ndef })) : [];
    const ok = f && keys.every((k) => params.some((p) => p.name === k)) && params.every((p) => !p.required || keys.includes(p.name));
    if (!ok) {
      const list = keys.slice().sort().join(', ');
      return {
        status: 404,
        body: {
          code: 'PGRST202', details: 'Searched for the function public.' + fn + ' with parameters ' + list,
          hint: null, message: 'Could not find the function public.' + fn + '(' + list + ') in the schema cache',
        },
      };
    }
    const used = params.filter((p) => keys.includes(p.name));
    const sql = used.length
      ? 'select to_json(public.' + ident(fn) + '(' + used.map((p) => ident(p.name) + ' := a.' + ident(p.name)).join(', ') + '))::text as body'
        + ' from json_to_record($1::json) as a(' + used.map((p) => ident(p.name) + ' ' + p.type).join(', ') + ')'
      : 'select to_json(public.' + ident(fn) + '())::text as body';
    try {
      const body = await this.db.transaction(async (tx) => {
        if (f.vol !== 'v') await tx.exec('set transaction read only');
        await tx.exec('set local role ' + ident(role));
        const r = await tx.query(sql, used.length ? [JSON.stringify(args)] : []);
        return r.rows[0].body;
      });
      return { status: 200, body: body == null ? null : JSON.parse(body) };
    } catch (e) {
      if (!e || typeof e.code !== 'string') throw e;
      return {
        status: httpStatus(e.code, role),
        body: { code: e.code, details: e.detail || null, hint: e.hint || null, message: e.message },
      };
    }
  }

  /** Delete all rooms (superuser). */
  reset() {
    return this.serial(() => this.db.exec('truncate clipshare.chunks, clipshare.items'));
  }

  counts() {
    return this.serial(async () => (await this.db.query(
      'select count(*)::int as items, coalesce(max(seq), 0)::int as seq from clipshare.items')).rows[0]);
  }
}

module.exports = { openDb, install, Rest, httpStatus, SETUP_SQL };
