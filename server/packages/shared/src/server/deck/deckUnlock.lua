-- Releases a refill guard only while it is still the caller's.
-- KEYS[1]: deck:lock:<uid>. ARGV[1]: the token the caller set.
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
