-- One move of a call: a compare-and-set on the state it was read in (and,
-- for an answer and a timeout, on which side of the ring's end it falls).
-- Field-level writes: a move never wipes a field another move wrote (the
-- ring's stamp, the room's presence).
--
-- KEYS[1] call:<id>  KEYS[2] busy:<caller>  KEYS[3] busy:<callee>
-- KEYS[4] calls:live  KEYS[5] call:<id>:in
-- ARGV[1] the states it may move from, '|'-separated ('ringing', 'connecting|active')
-- ARGV[2] the new state
-- ARGV[3] the ring: 'on' (still ringing), 'over' (rang out) or 'any'
-- ARGV[4] now (ms)  ARGV[5] the finished call's tombstone (s)
-- ARGV[6] '1': refuse a call that rings nobody
-- ARGV[7..] field, value pairs written with the move
--
-- A terminal move (ended, missed, cancelled) frees both people (only the
-- busy keys that still name this call: KEYS[1] itself), leaves the live set
-- and keeps the hash as a tombstone. Returns the hash after the move, or
-- false when it did not take place.
local st = redis.call('HGET', KEYS[1], 'st')
if not st then return false end
if not string.find('|' .. ARGV[1] .. '|', '|' .. st .. '|', 1, true) then return false end
if ARGV[6] == '1' and redis.call('HEXISTS', KEYS[1], 'fk') == 1 then return false end

local now = tonumber(ARGV[4])
local due = tonumber(redis.call('HGET', KEYS[1], 'pl')) + tonumber(redis.call('HGET', KEYS[1], 'rd'))
if ARGV[3] == 'on' and now >= due then return false end
if ARGV[3] == 'over' and now < due then return false end

for i = 7, #ARGV, 2 do redis.call('HSET', KEYS[1], ARGV[i], ARGV[i + 1]) end
redis.call('HSET', KEYS[1], 'st', ARGV[2])

if ARGV[2] == 'ended' or ARGV[2] == 'missed' or ARGV[2] == 'cancelled' then
  if redis.call('GET', KEYS[2]) == KEYS[1] then redis.call('DEL', KEYS[2]) end
  if redis.call('GET', KEYS[3]) == KEYS[1] then redis.call('DEL', KEYS[3]) end
  redis.call('ZREM', KEYS[4], redis.call('HGET', KEYS[1], 'id'))
  local tomb = tonumber(ARGV[5])
  redis.call('EXPIRE', KEYS[1], tomb)
  if redis.call('EXISTS', KEYS[5]) == 1 then redis.call('EXPIRE', KEYS[5], tomb) end
end
return redis.call('HGETALL', KEYS[1])
