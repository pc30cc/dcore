-- Starts an OTP challenge: KEYS[1] otp:<phoneHash> (the one live challenge
-- of the number, replacing an earlier one), KEYS[2] otp:c:<challengeId>
-- (challenge id -> phone hash). ARGV: challenge id, HMAC of the code (never
-- the code), code length, sealed number, purpose, review flag, lifetime
-- (ms), phone hash.
redis.call('DEL', KEYS[1])
redis.call('HSET', KEYS[1], 'c', ARGV[1], 'h', ARGV[2], 'n', 0, 'len', ARGV[3], 's', ARGV[4], 'k', ARGV[5], 'r', ARGV[6])
redis.call('PEXPIRE', KEYS[1], ARGV[7])
redis.call('SET', KEYS[2], ARGV[8], 'PX', ARGV[7])
return 1
