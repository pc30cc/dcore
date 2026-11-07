-- A quota counter checked and counted together (daily likes, weekly super
-- likes). KEYS[1]: the period's counter. ARGV[1]: the limit (-1 unlimited),
-- ARGV[2]: the counter's lifetime in seconds (set when it is made), ARGV[3]:
-- the amount: positive to use, negative to give back (never below zero).
-- Returns {1, used} when counted, {0, used} when the limit would be passed
-- (nothing counted).
local limit = tonumber(ARGV[1])
local n = tonumber(ARGV[3])
local used = tonumber(redis.call('GET', KEYS[1]) or '0') or 0
if n < 0 then
  if used <= 0 then return {1, 0} end
  local back = math.min(used, -n)
  used = redis.call('DECRBY', KEYS[1], back)
  return {1, used}
end
if limit >= 0 and used + n > limit then return {0, used} end
used = redis.call('INCRBY', KEYS[1], n)
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]), 'NX')
return {1, used}
