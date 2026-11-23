import { describe, expect, it } from 'vitest';
import { hasAccess } from '@/lib/providers/custom-provider-service';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const user = (id: string) => ({ id, role: 'user' as const });
const admin = { id: 'admin', role: 'admin' as const };

describe('phân quyền Custom Provider (spec 004, FR-013)', () => {
  it('public: mọi User', () => {
    expect(hasAccess(user(A), { accessMode: 'public', assignedUserIds: [] })).toBe(true);
  });

  it('restricted: chỉ User trong danh sách', () => {
    const p = { accessMode: 'restricted' as const, assignedUserIds: [A] };
    expect(hasAccess(user(A), p)).toBe(true);
    expect(hasAccess(user(B), p)).toBe(false);
  });

  it('private: chỉ Administrator', () => {
    const p = { accessMode: 'private' as const, assignedUserIds: [A] };
    expect(hasAccess(user(A), p)).toBe(false);
    expect(hasAccess(admin, p)).toBe(true);
  });
});
