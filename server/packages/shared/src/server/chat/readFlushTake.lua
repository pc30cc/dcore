-- The next chunk of conversations for the read-pointer flush. Taken out of
-- rp:dirty into rp:flushing in one step, so a flush that dies between the
-- take and its write (a deploy, an out-of-memory kill) loses nothing: what
-- rp:flushing still holds is the next run's first chunk. A receipt that
-- moves a pointer meanwhile adds its conversation to rp:dirty again, and a
-- later chunk writes the newer pointer.
--
-- KEYS[1] rp:dirty  KEYS[2] rp:flushing  ARGV[1] the chunk size
-- Returns {'left' | 'new', id...}: the ids left by a run that did not finish
-- first, else ids just taken from rp:dirty.
local n = tonumber(ARGV[1])
local left = redis.call('SRANDMEMBER', KEYS[2], n)
if #left > 0 then
  table.insert(left, 1, 'left')
  return left
end
local ids = redis.call('SPOP', KEYS[1], n)
for i = 1, #ids, 500 do
  redis.call('SADD', KEYS[2], unpack(ids, i, math.min(i + 499, #ids)))
end
table.insert(ids, 1, 'new')
return ids
