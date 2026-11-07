-- Checks a code against a challenge. KEYS[1] otp:<phoneHash>, KEYS[2]
-- otp:c:<challengeId>, KEYS[3] the per-IP verify counter, KEYS[4] the wrong
-- codes of the number today (review challenges only: their code is fixed,
-- so they get a daily cap of their own). ARGV: challenge id, purpose, IP
-- cap, IP window (ms), wrong codes allowed, the HMAC of the given code bound
-- to this challenge, the HMAC of the given code as a review-account code,
-- the review number's daily cap of wrong codes, its window (ms).
--
-- Replies: {'ip_limited', ms} · {'missing'} (expired, replaced, or another
-- purpose) · {'locked'} (the last allowed wrong code, a review number at its
-- daily cap, or already dead: the challenge is gone) · {'wrong', attempts
-- left} · {'ok', sealed number, review flag} (the challenge is gone: a code
-- works once).
local tries = redis.call('INCR', KEYS[3])
if tries == 1 then redis.call('PEXPIRE', KEYS[3], ARGV[4]) end
if tries > tonumber(ARGV[3]) then
  return {'ip_limited', redis.call('PTTL', KEYS[3])}
end
local fields = redis.call('HMGET', KEYS[1], 'c', 'h', 'n', 'k', 'r', 's')
local c, h, n, k, r, s = fields[1], fields[2], fields[3], fields[4], fields[5], fields[6]
if not c or c ~= ARGV[1] or k ~= ARGV[2] then
  return {'missing'}
end
local review = r == '1'
local reviewCap = tonumber(ARGV[8])
if review and (tonumber(redis.call('GET', KEYS[4]) or '0') or 0) >= reviewCap then
  redis.call('DEL', KEYS[1], KEYS[2])
  return {'locked'}
end
local allowed = tonumber(ARGV[5])
local used = tonumber(n) or 0
if used >= allowed then
  redis.call('DEL', KEYS[1], KEYS[2])
  return {'locked'}
end
local candidate = ARGV[6]
if review then candidate = ARGV[7] end
if h == candidate then
  redis.call('DEL', KEYS[1], KEYS[2])
  return {'ok', s, r}
end
used = redis.call('HINCRBY', KEYS[1], 'n', 1)
if review then
  local wrong = redis.call('INCR', KEYS[4])
  if wrong == 1 then redis.call('PEXPIRE', KEYS[4], ARGV[9]) end
  if wrong >= reviewCap then
    redis.call('DEL', KEYS[1], KEYS[2])
    return {'locked'}
  end
end
if used >= allowed then
  redis.call('DEL', KEYS[1], KEYS[2])
  return {'locked'}
end
return {'wrong', allowed - used}
