-- The conversation list state of a message written somewhere else than the
-- send path (a call line, a like note, the first message of an accepted
-- request), once it is durable: the newest message (only by a newer id),
-- both lists' order, an unread count and both list versions. Nothing once
-- the conversation ended (`mte:<m>`).
--
-- KEYS[1] mte:<m>  KEYS[2] lm:<m>  KEYS[3] cl:<lo>  KEYS[4] cl:<hi>
-- KEYS[5] unr:<lo>  KEYS[6] unr:<hi>  KEYS[7] cv:<lo>  KEYS[8] cv:<hi>
--
-- ARGV[1] message id, ARGV[2] match id, ARGV[3] sender id, ARGV[4] kind
-- code, ARGV[5] ref id or '', ARGV[6] flags, ARGV[7] preview, ARGV[8] the
-- message's time (ms), ARGV[9] the side whose unread count grows ('lo',
-- 'hi' or ''), ARGV[10] lm: lifetime (s), ARGV[11] lists' lifetime (s),
-- ARGV[12] now (ms).
--
-- Returns 1 when the state moved, 0 when the conversation ended or a newer
-- message is already the preview (the order and the count still move).

local function newer(a, b)
  if #a ~= #b then return #a > #b end
  return a > b
end

local function bump(key, now, ttl)
  local current = tonumber(redis.call('GET', key) or '')
  local nextValue = now
  if current and current >= now then nextValue = current + 1 end
  redis.call('SET', key, nextValue, 'EX', ttl)
end

if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
local listTtl = tonumber(ARGV[11])
local last = redis.call('HGET', KEYS[2], 'id')
local moved = 0
if (not last) or newer(ARGV[1], last) then
  redis.call('HSET', KEYS[2], 'id', ARGV[1], 's', ARGV[3], 'k', ARGV[4], 'r', ARGV[5], 'f', ARGV[6], 'p', ARGV[7])
  redis.call('EXPIRE', KEYS[2], tonumber(ARGV[10]))
  moved = 1
end
for i = 3, 4 do
  redis.call('ZADD', KEYS[i], 'GT', tonumber(ARGV[8]), ARGV[2])
  redis.call('EXPIRE', KEYS[i], listTtl)
end
if ARGV[9] == 'lo' then
  redis.call('HINCRBY', KEYS[5], ARGV[2], 1)
  redis.call('EXPIRE', KEYS[5], listTtl)
elseif ARGV[9] == 'hi' then
  redis.call('HINCRBY', KEYS[6], ARGV[2], 1)
  redis.call('EXPIRE', KEYS[6], listTtl)
end
local now = tonumber(ARGV[12])
bump(KEYS[7], now, listTtl)
bump(KEYS[8], now, listTtl)
return moved
