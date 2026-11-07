-- A version counter that never repeats a value, even after the key was
-- lost: a missing key starts at the current time in milliseconds, and a
-- bump moves to max(now, current + 1). KEYS[1]: the counter.
-- ARGV[1]: now (ms), ARGV[2]: lifetime in seconds (renewed on every call),
-- ARGV[3]: 'read' (start the counter if missing) or 'bump'.
local current = tonumber(redis.call('GET', KEYS[1]) or '')
local now = tonumber(ARGV[1])
if ARGV[3] == 'read' and current then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
  return current
end
local nextValue = now
if current and current >= now then nextValue = current + 1 end
redis.call('SET', KEYS[1], nextValue, 'EX', ARGV[2])
return nextValue
