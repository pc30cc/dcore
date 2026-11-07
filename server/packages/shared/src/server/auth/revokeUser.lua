-- Raises the user-wide revocation cutoff in KEYS[1] to ARGV[1] (unix
-- seconds) and never lowers it, so two revocations racing each other keep
-- the later one. ARGV[2]: the key's lifetime in seconds. Returns the cutoff.
local current = tonumber(redis.call('GET', KEYS[1]) or '0') or 0
local cutoff = tonumber(ARGV[1])
if current > cutoff then cutoff = current end
redis.call('SET', KEYS[1], cutoff, 'EX', ARGV[2])
return cutoff
