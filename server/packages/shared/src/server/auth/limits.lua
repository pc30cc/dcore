-- Fixed-window counters checked and counted together, atomically, for
-- limits that must hold (sign-in, OTP). KEYS[i]: the counters. ARGV[1]:
-- 1 to count, 0 to check only; then per key ARGV[2i]: the cap and
-- ARGV[2i+1]: the window in ms, which starts at the key's first count.
-- If any counter is at its cap nothing is counted, and the reply is
-- {i, ms until that window ends}; else every counter is counted and the
-- reply is {0, 0}.
local count = ARGV[1] == '1'
for i = 1, #KEYS do
  local cap = tonumber(ARGV[2 * i])
  local current = tonumber(redis.call('GET', KEYS[i]) or '0') or 0
  if current >= cap then
    local ttl = redis.call('PTTL', KEYS[i])
    if ttl < 0 then
      -- A counter left without a window (it cannot normally happen): give it one.
      ttl = tonumber(ARGV[2 * i + 1])
      redis.call('PEXPIRE', KEYS[i], ttl)
    end
    return {i, ttl}
  end
end
if count then
  for i = 1, #KEYS do
    if redis.call('INCR', KEYS[i]) == 1 then
      redis.call('PEXPIRE', KEYS[i], ARGV[2 * i + 1])
    end
  end
end
return {0, 0}
