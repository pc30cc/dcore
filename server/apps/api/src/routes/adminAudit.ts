import { adminAuditAdmins, adminAuditSearch, type AdminAuditRow, type AuditSearch } from '@app/db';
import {
  AUDIT_EXPORT_MAX_ROWS,
  PUBLIC_UID_PATTERN,
  adminAuditAdminsSchema,
  adminAuditExportSchema,
  adminAuditQuerySchema,
  auditPageSchema,
  auditTarget,
  idSchema,
  type AuditEntry,
  type AuditFilters,
} from '@app/shared';
import type { FastifyInstance } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { adminWrite } from '../admin/audit.js';
import { takeAdminLimit } from '../admin/limits.js';
import { fieldInvalid, pageOf, readCursorKey } from '../admin/cursors.js';
import { auditEntryOf, callerMay, userReadScope } from '../admin/refs.js';
import { HttpProblem } from '../lib/problem.js';

/**
 * The audit log in the admin panel:
 *
 *   GET  /v1/admin/audit           newest first; ?admin&targetType&target&action&from&to, each alone or combined
 *   GET  /v1/admin/audit/admins    the admins the page filters by
 *   POST /v1/admin/audit/export    the same filters in the body → text/csv (10/h per admin, at most 10,000 rows)
 *
 * A time range is an id range (ids carry their time), so a search reads the
 * primary key or the index its filter names, newest first, `LIMIT n + 1`.
 * `target` is a person's public id when the type is `user`, else the row's
 * decimal id. An export is itself audited (`audit.export`, the filters and
 * the row count) before its file is sent. A caller who may not see
 * shadowbans (`userReadScope`) reads neither a shadowban, nor its lift, nor
 * an export filtered on shadowbans, in the page and in the file alike (left
 * out by the search itself), nor the flag or a "shadowban" resolution in a
 * detail (`auditEntryOf`).
 */

const auditCursor = z.object({ id: idSchema });
const EXPORT_PER_HOUR = 10;
const DAY_MS = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A bound as epoch ms: a day starts at 00:00 UTC; `to` of a day is the next day's start (the day is included). */
function boundMs(value: string | undefined, end: boolean): number | undefined {
  if (value === undefined) return undefined;
  const ms = DATE.test(value) ? Date.parse(`${value}T00:00:00.000Z`) + (end ? DAY_MS : 0) : Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function badQuery(pointer: string, message: string, where: 'query' | 'body'): HttpProblem {
  if (where === 'body') return fieldInvalid(pointer, 'invalid', message);
  return new HttpProblem('validation_failed', { detail: message, errors: [{ in: 'query', pointer, code: 'invalid', message }] });
}

/** The filters as the database reads them; null when the target is a well-formed public id of nobody (nothing can match). */
function searchOf(app: FastifyInstance, filters: AuditFilters, where: 'query' | 'body'): Omit<AuditSearch, 'limit' | 'beforeId' | 'withShadowbans'> | null {
  let targetId: string | undefined;
  if (filters.target !== undefined) {
    if (filters.targetType === 'user') {
      if (!PUBLIC_UID_PATTERN.test(filters.target)) throw badQuery('/target', 'A person is named by their public id.', where);
      const decoded = app.publicIds.user.decodeId(filters.target);
      if (decoded === null) return null;
      targetId = decoded;
    } else {
      if (!idSchema.safeParse(filters.target).success) throw badQuery('/target', 'Not an id.', where);
      targetId = filters.target;
    }
  }
  const fromMs = boundMs(filters.from, false);
  const toMs = boundMs(filters.to, true);
  if (fromMs !== undefined && toMs !== undefined && toMs <= fromMs) throw badQuery('/to', 'The end comes before the start.', where);
  return {
    adminId: filters.admin === undefined ? undefined : Number(filters.admin),
    targetType: filters.targetType === undefined ? undefined : auditTarget.code(filters.targetType),
    targetId,
    action: filters.action,
    fromMs,
    toMs,
  };
}

// ─── CSV (RFC 4180) ───────────────────────────────────────────────────────

const CSV_HEADER = ['time', 'admin_id', 'admin', 'action', 'target_type', 'target', 'ip', 'detail'];

/** One cell: a value a spreadsheet would run as a formula gets a leading `'`; quoted when it holds a comma, a quote or a line break. */
export function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

function csvRow(cells: readonly string[]): string {
  return cells.map(csvCell).join(',');
}

function csvOf(entries: readonly AuditEntry[]): string {
  const lines = [csvRow(CSV_HEADER)];
  for (const entry of entries) {
    lines.push(
      csvRow([
        entry.at,
        entry.admin?.id ?? '',
        entry.admin?.displayName ?? '',
        entry.action,
        entry.targetType,
        entry.user ?? entry.targetRef ?? '',
        entry.ip ?? '',
        entry.detail === null ? '' : JSON.stringify(entry.detail),
      ]),
    );
  }
  // A byte-order mark, so spreadsheet programs read the file as UTF-8 (names in any script).
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

function exportName(filters: AuditFilters): string {
  const day = (value: string | undefined) => (value ?? '').slice(0, 10);
  const parts = ['audit', day(filters.from), day(filters.to)].filter((part) => part !== '');
  return `${parts.join('-')}.csv`;
}


export const adminAuditRoutes: FastifyPluginAsyncZod = async (app) => {
  const tags = ['admin'];
  const read = app.requirePermission('audit.read');

  app.get(
    '/v1/admin/audit',
    {
      preHandler: read,
      config: { pgBudget: 1 },
      schema: { tags, summary: 'The audit log, newest first, by admin, target, action and time', querystring: adminAuditQuerySchema, response: { 200: auditPageSchema } },
    },
    async (request) => {
      const { cursor, limit, ...filters } = request.query;
      const key = readCursorKey(auditCursor, cursor);
      const search = searchOf(app, filters, 'query');
      if (search === null) return { items: [], nextCursor: null };
      const { shadow } = userReadScope(app, request);
      const rows = await adminAuditSearch(app.pg, { ...search, beforeId: key?.id ?? null, limit: limit + 1, withShadowbans: shadow });
      const adminDetails = callerMay(app, request, 'admins.read');
      return pageOf(rows, limit, (row) => auditEntryOf(app, row, { adminDetails, shadow }), (row) => ({ id: row.id }));
    },
  );

  app.get(
    '/v1/admin/audit/admins',
    {
      preHandler: read,
      config: { pgBudget: 1 },
      schema: { tags, summary: 'The admins the audit log can be filtered by', response: { 200: adminAuditAdminsSchema } },
    },
    async () => {
      const rows = await adminAuditAdmins(app.pg);
      return { items: rows.map((row) => ({ id: String(row.id), displayName: row.displayName, disabled: row.disabled })) };
    },
  );

  app.post(
    '/v1/admin/audit/export',
    {
      preHandler: read,
      config: { pgBudget: 2 },
      schema: { tags, summary: 'The audit rows of a filter as a CSV file (each export is audited)', body: adminAuditExportSchema },
    },
    async (request, reply) => {
      const filters = request.body;
      const search = searchOf(app, filters, 'body');
      const { shadow } = userReadScope(app, request);
      const ticket = await takeAdminLimit(app, request, 'admin_audit_export', EXPORT_PER_HOUR);
      let rows: AdminAuditRow[] | null = null;
      try {
        rows = await adminWrite(app, request, async (tx, trail) => {
          const found = search === null ? [] : await adminAuditSearch(tx, { ...search, limit: AUDIT_EXPORT_MAX_ROWS + 1, withShadowbans: shadow });
          if (found.length > AUDIT_EXPORT_MAX_ROWS) throw fieldInvalid('', 'too_many_rows', 'Narrow the filter.');
          trail.record({ action: 'audit.export', target: 'none', detail: { filters, rows: found.length } });
          return found;
        });
      } finally {
        // Only an export that was written (with its audit row) counts against the hour.
        if (rows === null) await ticket.refund();
      }
      const adminDetails = callerMay(app, request, 'admins.read');
      const csv = csvOf(rows.map((row) => auditEntryOf(app, row, { adminDetails, shadow })));
      return reply
        .code(200)
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="${exportName(filters)}"`)
        .header('cache-control', 'no-store')
        .send(csv);
    },
  );
};
