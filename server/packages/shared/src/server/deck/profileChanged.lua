-- People whose card changed: each gets a stamp in `vis:chg` that only ever
-- grows (the time in ms, or one more than the stamp it had), so a reader that
-- noted a stamp sees a later change as a larger one whatever the clocks of
-- the writers. Stamps older than the window are trimmed in the same call.
--
-- KEYS[1] vis:chg
-- ARGV[1] now (ms), ARGV[2] window (ms), ARGV[3..] user ids

local now = tonumber(ARGV[1])
for i = 3, #ARGV do
  local current = tonumber(redis.call('ZSCORE', KEYS[1], ARGV[i]) or '0')
  local stamp = now
  if current >= stamp then stamp = current + 1 end
  redis.call('ZADD', KEYS[1], stamp, ARGV[i])
end
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - tonumber(ARGV[2]))
return 1
