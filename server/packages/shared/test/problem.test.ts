import { describe, expect, it } from 'vitest';
import { errorCodeStatus, errorCodes, problem, problemSchema, problemType, toJsonPointer } from '../src/index.js';

describe('problem documents', () => {
  it('builds a valid document for every known code', () => {
    for (const code of errorCodes) {
      const doc = problem(code, { requestId: 'req-1' });
      expect(problemSchema.parse(doc)).toEqual(doc);
      expect(doc.status).toBe(errorCodeStatus[code]);
      expect(doc.type).toBe(problemType(code));
      expect(doc.type).toMatch(/^urn:problem-type:[a-z-]+$/);
    }
  });

  it('omits fields that were not given', () => {
    expect(Object.keys(problem('not_found'))).toEqual(['type', 'title', 'status', 'code']);
  });

  it('accepts codes a client does not know yet', () => {
    const parsed = problemSchema.parse({ type: 'urn:problem-type:new', title: 'New', status: 422, code: 'brand_new' });
    expect(parsed.code).toBe('brand_new');
  });

  it('escapes JSON Pointer segments', () => {
    expect(toJsonPointer(['photos', 0, 'id'])).toBe('/photos/0/id');
    expect(toJsonPointer(['a/b', 'c~d'])).toBe('/a~1b/c~0d');
    expect(toJsonPointer([])).toBe('');
  });
});
