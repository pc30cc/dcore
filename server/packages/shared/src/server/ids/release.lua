-- Frees KEYS[1] if this process (ARGV[1]) still holds it. Returns 1 or 0.
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
