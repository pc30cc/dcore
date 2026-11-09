-- A participant joined the call's room (LiveKit's webhook): its identity is
-- kept in the room's presence set, and an answered call becomes active once
-- both people's identities are in it.
--
-- KEYS[1] call:<id>  KEYS[2] call:<id>:in
-- ARGV[1] the identity that joined  ARGV[2] the caller's identity
-- ARGV[3] the callee's identity  ARGV[4] now (ms)
--
-- Returns {verdict, hash...}: 'activated', 'joined', 'over' (the call is
-- finished: its room should go), or 'missing' without the hash.
local function answer(verdict)
  local out = { verdict }
  local h = redis.call('HGETALL', KEYS[1])
  for i = 1, #h do out[#out + 1] = h[i] end
  return out
end

local st = redis.call('HGET', KEYS[1], 'st')
if not st then return { 'missing' } end
if st ~= 'ringing' and st ~= 'connecting' and st ~= 'active' then return answer('over') end
redis.call('SADD', KEYS[2], ARGV[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl > 0 then redis.call('PEXPIRE', KEYS[2], ttl) end
if st == 'connecting'
  and redis.call('SISMEMBER', KEYS[2], ARGV[2]) == 1
  and redis.call('SISMEMBER', KEYS[2], ARGV[3]) == 1 then
  redis.call('HSET', KEYS[1], 'st', 'active', 'ac', ARGV[4])
  return answer('activated')
end
return answer('joined')
