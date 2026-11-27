-- 0033 - Admin: reading a person's conversations (users.chats).
--
-- users.chats is restricted (packages/shared/src/permissions.ts): users.* does
-- not cover it, so the admin role gets it by name; superadmin's '*' covers
-- it. No other seeded role holds it. Reading a conversation writes nothing:
-- no audit row, no other record, no read or delivered pointer. No table,
-- column or index changes.
INSERT INTO admin_role_permissions (role_id, permission)
SELECT r.id, 'users.chats' FROM admin_roles r WHERE r.key = 'admin'
ON CONFLICT DO NOTHING;
