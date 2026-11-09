-- Places a call: the busy rule, the live cap and the new call hash in one
-- step, so two calls placed at the same moment that share a person never
-- both ring, and two pairs at the cap minus one never both get through.
--
-- KEYS[1] busy:<caller>  KEYS[2] busy:<callee>  KEYS[3] call:<id>  KEYS[4] calls:live
-- KEYS[5] mte:<matchId> (the conversation ended: a call checked against a
-- state read just before a block or an unmatch never rings)
-- ARGV[1] call id  ARGV[2] now (ms)  ARGV[3] the live cap (-1: none)
-- ARGV[4] the hash's lifetime (s)  ARGV[5] the ring (ms)
-- ARGV[6] 'shadow' for a caller nobody may see, else ''
-- ARGV[7..] field, value pairs of the new hash
--
-- busy:<uid> holds the full name of the call hash (KEYS[3] as the caller
-- passed it, deployment prefix included): a name built here would miss the
-- prefix. A person is held by a call that is connecting or active, or
-- ringing with ring left; anything else is a stale busy key.
--
-- Returns 'placed', 'callee_busy' or 'shadow' (a call that rings nobody:
-- the hash is written and holds the caller, never the callee; it rings as
-- long as any call, so its end tells nothing), or 'ended', 'caller_busy',
-- 'limit_reached', 'exists' with nothing written.
local now = tonumber(ARGV[2])

local function holds(busyKey)
  local h = redis.call('GET', busyKey)
  if not h then return false end
  local st = redis.call('HGET', h, 'st')
  if st == 'connecting' or st == 'active' then return true end
  if st == 'ringing' then
    local pl = tonumber(redis.call('HGET', h, 'pl') or '')
    local rd = tonumber(redis.call('HGET', h, 'rd') or '')
    if pl and rd then return now < pl + rd end
  end
  return false
end

if redis.call('EXISTS', KEYS[3]) == 1 then return 'exists' end
if redis.call('EXISTS', KEYS[5]) == 1 then return 'ended' end
if holds(KEYS[1]) then return 'caller_busy' end
-- Calls whose hash expired without a terminal move leave the live set here.
redis.call('ZREMRANGEBYSCORE', KEYS[4], '-inf', now)
local max = tonumber(ARGV[3])
if max >= 0 and redis.call('ZCARD', KEYS[4]) >= max then return 'limit_reached' end

local verdict = 'placed'
if ARGV[6] == 'shadow' then
  verdict = 'shadow'
elseif holds(KEYS[2]) then
  verdict = 'callee_busy'
end

local ttl = tonumber(ARGV[4])
for i = 7, #ARGV, 2 do redis.call('HSET', KEYS[3], ARGV[i], ARGV[i + 1]) end
redis.call('HSET', KEYS[3], 'id', ARGV[1], 'st', 'ringing', 'pl', ARGV[2], 'rd', ARGV[5])
if verdict ~= 'placed' then
  redis.call('HSET', KEYS[3], 'fk', verdict == 'shadow' and 'shadow' or 'busy')
end
redis.call('EXPIRE', KEYS[3], ttl)
redis.call('SET', KEYS[1], KEYS[3], 'EX', ttl)
if verdict == 'placed' then
  redis.call('SET', KEYS[2], KEYS[3], 'EX', ttl)
  redis.call('ZADD', KEYS[4], now + ttl * 1000, ARGV[1])
end
return verdict
