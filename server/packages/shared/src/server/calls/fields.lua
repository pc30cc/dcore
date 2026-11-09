-- Writes fields of a call hash only while it exists: a late writer (a token
-- route, a finalize step) must never bring back a hash that expired, which
-- would then live without a lifetime.
--
-- KEYS[1] call:<id>  ARGV field, value pairs. Returns 1 when written, 0 when there is no hash.
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
for i = 1, #ARGV, 2 do redis.call('HSET', KEYS[1], ARGV[i], ARGV[i + 1]) end
return 1
