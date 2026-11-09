-- The conversation list state read back from PostgreSQL after it expired
-- or was lost: the newest message and both read pointers, written only
-- where Valkey holds nothing (a send or a receipt that landed meanwhile is
-- newer and stays).
--
-- KEYS[1] lm:<m>  KEYS[2] rp:<m>
--
-- ARGV[1] message id ('0': the conversation has no message), ARGV[2]
-- sender, ARGV[3] kind code, ARGV[4] ref id or '', ARGV[5] flags, ARGV[6]
-- preview, ARGV[7] lo's read pointer, ARGV[8] hi's ('0': nothing read),
-- ARGV[9] lm: lifetime (s), ARGV[10] rp: lifetime (s).

if redis.call('EXISTS', KEYS[1]) == 0 then
  redis.call('HSET', KEYS[1], 'id', ARGV[1], 's', ARGV[2], 'k', ARGV[3], 'r', ARGV[4], 'f', ARGV[5], 'p', ARGV[6])
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[9]))
end
local seeded = 0
if ARGV[7] ~= '0' then seeded = seeded + redis.call('HSETNX', KEYS[2], 'lo', ARGV[7]) end
if ARGV[8] ~= '0' then seeded = seeded + redis.call('HSETNX', KEYS[2], 'hi', ARGV[8]) end
if seeded > 0 then redis.call('EXPIRE', KEYS[2], tonumber(ARGV[10])) end
return 1
