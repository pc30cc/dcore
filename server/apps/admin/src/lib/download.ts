import { apiFile } from './api';

/**
 * Files the API answers (the audit log's CSV export): fetched with the
 * admin's token like every other call (a refresh and one retry on a 401, a
 * problem document on a refusal), then saved through an object URL, which
 * the panel's content policy allows (`blob:`).
 */

export async function apiDownload(path: string, body: unknown): Promise<Blob> {
  return apiFile(path, { method: 'POST', body });
}

export const REVOKE_AFTER_MS = 60_000;

/** Offers `blob` to the browser as a file named `name`. */
export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  // Late enough for every browser to have started the save (some cancel it when the address goes at once).
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
}
