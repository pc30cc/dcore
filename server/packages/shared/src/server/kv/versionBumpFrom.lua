-- A bump (as version.lua's) that also says whether the counter still held
-- the value the caller read before its write, i.e. whether no other change
-- was announced in between. KEYS[1]: the counter. ARGV[1]: now (ms),
-- ARGV[2]: lifetime in seconds, ARGV[3]: the value read before the write.
-- Reply: {new value, 1 when the counter held ARGV[3] else 0}.
local current = tonumber(redis.call('GET', KEYS[1]) or '')
local now = tonumber(ARGV[1])
local nextValue = now
if current and current >= now then nextValue = current + 1 end
redis.call('SET', KEYS[1], nextValue, 'EX', ARGV[2])
local same = 0
if current and current == tonumber(ARGV[3]) then same = 1 end
return {nextValue, same}
