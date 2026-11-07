-- Takes the first free key of KEYS (generator leases, lowest number first).
-- ARGV[1]: this process's lease value; ARGV[2]: the lease in milliseconds.
-- Returns the 1-based index of the key taken, or 0 when all are held.
for i = 1, #KEYS do
  if redis.call('SET', KEYS[i], ARGV[1], 'NX', 'PX', ARGV[2]) then
    return i
  end
end
return 0
