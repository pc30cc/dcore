import { originRoles, validateOrigins, type OriginRole, type OriginsAdminView, type OriginsIssue, type OriginsUpdateBody } from '@app/shared';

/**
 * The Hosts screen's form: one text box per role (one origin per line, in
 * order of preference), the URLs of the published copies, and the switch
 * that allows IP addresses. The rules are the API's own (`validateOrigins`
 * from `@app/shared`), checked here first so mistakes show next to their
 * line before anything is sent.
 */

export type HostsField = OriginRole | 'bootstrap';
export const hostsFields: readonly HostsField[] = [...originRoles, 'bootstrap'];

export interface HostsForm {
  lines: Record<HostsField, string>;
  allowIpHosts: boolean;
}

export function linesOf(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function formOf(view: Pick<OriginsAdminView, 'hosts' | 'bootstrap' | 'allowIpHosts'>): HostsForm {
  return {
    lines: {
      api: view.hosts.api.join('\n'),
      realtime: view.hosts.realtime.join('\n'),
      rtc: view.hosts.rtc.join('\n'),
      cdn: view.hosts.cdn.join('\n'),
      web: view.hosts.web.join('\n'),
      bootstrap: view.bootstrap.join('\n'),
    },
    allowIpHosts: view.allowIpHosts,
  };
}

export function requestOf(form: HostsForm, baseVersion: number): OriginsUpdateBody {
  return {
    hosts: {
      api: linesOf(form.lines.api),
      realtime: linesOf(form.lines.realtime),
      rtc: linesOf(form.lines.rtc),
      cdn: linesOf(form.lines.cdn),
      web: linesOf(form.lines.web),
    },
    bootstrap: linesOf(form.lines.bootstrap),
    allowIpHosts: form.allowIpHosts,
    baseVersion,
  };
}

export interface FieldProblem {
  field: HostsField;
  /** The 1-based line, when the problem is one entry. */
  line?: number;
  message: string;
}

/** Problems by field, from the API's pointers (`/hosts/api/1`, `/bootstrap/0`, `/hosts/api`). */
export function problemsOf(issues: readonly Pick<OriginsIssue, 'pointer' | 'message'>[]): FieldProblem[] {
  const out: FieldProblem[] = [];
  for (const issue of issues) {
    const parts = issue.pointer.split('/').slice(1);
    const field = (parts[0] === 'hosts' ? parts[1] : parts[0]) as HostsField | undefined;
    if (!field || !hostsFields.includes(field)) continue;
    const index = parts[0] === 'hosts' ? parts[2] : parts[1];
    out.push({ field, ...(index !== undefined && /^\d+$/.test(index) ? { line: Number(index) + 1 } : {}), message: issue.message });
  }
  return out;
}

/** The same rules as the API, before sending. */
export function checkForm(form: HostsForm): FieldProblem[] {
  const request = requestOf(form, 0);
  const checked = validateOrigins({ hosts: request.hosts, bootstrap: request.bootstrap, allowIpHosts: request.allowIpHosts });
  return checked.ok ? [] : problemsOf(checked.issues);
}
