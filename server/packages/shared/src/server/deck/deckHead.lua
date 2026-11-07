-- The head of a prepared deck in one round trip.
-- KEYS[1]: deck:<uid> (list of user ids). KEYS[2]: deckm:<uid> (hash).
-- ARGV[1]: how many ids from the head.
-- Returns {length, builtAt, exhaustedAt, cursor, id1, meta1, id2, meta2, ...};
-- '' stands for a missing value (a Lua table cannot hold nil).
local ids = redis.call('LRANGE', KEYS[1], 0, tonumber(ARGV[1]) - 1)
local out = { redis.call('LLEN', KEYS[1]) }
local specials = redis.call('HMGET', KEYS[2], '@at', '@x', '@c')
for i = 1, 3 do out[#out + 1] = specials[i] or '' end
if #ids > 0 then
  local metas = redis.call('HMGET', KEYS[2], unpack(ids))
  for i = 1, #ids do
    out[#out + 1] = ids[i]
    out[#out + 1] = metas[i] or ''
  end
end
return out
