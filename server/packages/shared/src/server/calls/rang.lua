-- A phone of the callee shows the ring: the first word, while the call
-- still rings, stamps when (server time) and whether the caller may know
-- (the callee shows when they are online). Not a move: nothing else changes.
--
-- KEYS[1] call:<id>
-- ARGV[1] now (ms)  ARGV[2] '1' when the caller may be told, else '0'
--
-- Returns {verdict, hash...}: 'stamped', 'already' (another phone was first),
-- 'over' (the ring ran out; nobody missed it yet), 'not_ringing'; 'missing'
-- without the hash.
local function answer(verdict)
  local out = { verdict }
  local h = redis.call('HGETALL', KEYS[1])
  for i = 1, #h do out[#out + 1] = h[i] end
  return out
end

local st = redis.call('HGET', KEYS[1], 'st')
if not st then return { 'missing' } end
if st ~= 'ringing' or redis.call('HEXISTS', KEYS[1], 'fk') == 1 then return answer('not_ringing') end
local now = tonumber(ARGV[1])
if now >= tonumber(redis.call('HGET', KEYS[1], 'pl')) + tonumber(redis.call('HGET', KEYS[1], 'rd')) then
  return answer('over')
end
if redis.call('HSETNX', KEYS[1], 'rg', ARGV[1]) == 0 then return answer('already') end
redis.call('HSET', KEYS[1], 'rgs', ARGV[2])
return answer('stamped')
