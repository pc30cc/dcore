-- One call to a store's API, counted per UTC day and per minute.
-- KEYS[1] the day's counter, KEYS[2] the minute's counter
-- ARGV[1] 1 urgent (always counted and allowed), 0 background
-- ARGV[2] the day's cap for background calls, ARGV[3] the minute's cap for background calls
-- ARGV[4] the day counter's ttl (s), ARGV[5] the minute counter's ttl (s)
-- Returns {allowed (1/0), day count, minute count}.
local day = tonumber(redis.call('GET', KEYS[1]) or '0')
local minute = tonumber(redis.call('GET', KEYS[2]) or '0')
if ARGV[1] == '0' and (day >= tonumber(ARGV[2]) or minute >= tonumber(ARGV[3])) then
  return {0, day, minute}
end
day = redis.call('INCR', KEYS[1])
if day == 1 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[4])) end
minute = redis.call('INCR', KEYS[2])
if minute == 1 then redis.call('EXPIRE', KEYS[2], tonumber(ARGV[5])) end
return {1, day, minute}
