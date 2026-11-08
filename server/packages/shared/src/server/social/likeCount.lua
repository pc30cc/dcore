-- How many people wait for an answer from one person, without reading who:
-- per live week, the pending likers plus the super likers kept apart from a
-- bucket at its cap (SCARD of both minus their overlap), and whether a
-- bucket reached its cap (the count is then a lower bound).
--
-- KEYS[1..5]   lkin:<uid>:<w-4..w>
-- KEYS[6..10]  lkin:<uid>:<w-4..w>:s
-- KEYS[11..15] lkin:<uid>:<w-4..w>:full
--
-- Returns {total, capped (0 or 1)}.

local total = 0
local capped = 0
for i = 1, 5 do
  local likers = redis.call('SCARD', KEYS[i])
  local supers = redis.call('SCARD', KEYS[5 + i])
  local both = 0
  if likers > 0 and supers > 0 then both = redis.call('SINTERCARD', 2, KEYS[i], KEYS[5 + i]) end
  total = total + likers + supers - both
  if redis.call('EXISTS', KEYS[10 + i]) == 1 then capped = 1 end
end
return {total, capped}
