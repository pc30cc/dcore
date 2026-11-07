-- Extends this process's lease on KEYS[1] if it still holds it.
-- ARGV[1]: the lease value; ARGV[2]: the lease in milliseconds.
-- Returns 1 when extended, 0 when the lease was lost (expired or taken).
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
