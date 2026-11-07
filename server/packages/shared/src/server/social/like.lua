-- One like or super like, atomically: mutual-like detection against the
-- actor's buckets of pending likers, the append to the write-behind stream,
-- and the bucket of the target. Ids are minted by the caller before the call,
-- so an entry appended here is durable with the ids every later step uses.
--
-- KEYS[1..5]   lkin:<actor>:<w-4..w>         who liked the actor, by week
-- KEYS[6..10]  lkin:<target>:<w-4..w>        who liked the target, by week
-- KEYS[11]     wb:like                       KEYS[12] wb:match
-- KEYS[13]     lkin:<target>:<w>:full        the target's current bucket is at its cap
-- KEYS[14..18] lkin:<actor>:<w-4..w>:full    the actor's buckets at their cap
-- KEYS[19..23] lkin:<actor>:<w-4..w>:s       super likers of the actor
-- KEYS[24]     lkin:<target>:<w>:s           super likers of the target, this week
-- KEYS[25]     lk:ready                      the buckets are complete (absent after a loss)
-- KEYS[26]     lkm:<lo>:<hi>                 the pair matched (set here on a match, and by every announcement)
--
-- ARGV[1] target, ARGV[2] actor, ARGV[3] like id, ARGV[4] kind (1 like, 2 super
-- like), ARGV[5] item kind (0 profile, 1 photo, 2 prompt), ARGV[6] item ref (''
-- for none), ARGV[7] comment ('' for none), ARGV[8] bucket lifetime in seconds,
-- ARGV[9] bucket cap, ARGV[10] match id, ARGV[11] note id 1, ARGV[12] note id 2,
-- ARGV[13] '1' when the like row is already in PostgreSQL (paid from the wallet),
-- ARGV[14] lifetime of the matched-pair marker in seconds.
--
-- Returns 'match' (the target liked the actor: the match is appended to
-- wb:match with the pre-minted ids), 'duplicate' (the actor's like of the
-- target is still pending, or the pair has matched: a like sent again after
-- the match, by a resend or from a card shown before it; nothing written),
-- 'check' (the actor's own buckets
-- are incomplete, at their cap or after a loss: the caller looks the mutual
-- like up in PostgreSQL, and the stream entry asks the writer to look again
-- once the batch is durable) or 'liked'.

local function append_like(check)
  redis.call('XADD', KEYS[11], '*', 'id', ARGV[3], 't', ARGV[1], 'a', ARGV[2], 'k', ARGV[4],
             'ik', ARGV[5], 'ir', ARGV[6], 'c', ARGV[7], 'x', check, 'w', ARGV[13])
end

if redis.call('EXISTS', KEYS[26]) == 1 then return 'duplicate' end

for i = 1, 5 do
  if redis.call('SISMEMBER', KEYS[i], ARGV[1]) == 1 then
    -- The target liked the actor: a match. It is durable before the caller's
    -- INSERT, so a crash, a timeout or a database outage after this point
    -- loses nothing: the stream writer creates it with the same id.
    for j = 1, 5 do
      redis.call('SREM', KEYS[j], ARGV[1])
      redis.call('SREM', KEYS[18 + j], ARGV[1])
    end
    append_like('0')
    redis.call('SET', KEYS[26], 1, 'EX', tonumber(ARGV[14]))
    redis.call('XADD', KEYS[12], '*', 'm', ARGV[10], 'a', ARGV[2], 't', ARGV[1], 's', ARGV[4],
               'n1', ARGV[11], 'n2', ARGV[12], 'l', ARGV[3], 'ik', ARGV[5], 'ir', ARGV[6], 'c', ARGV[7])
    return 'match'
  end
end

for i = 6, 10 do
  if redis.call('SISMEMBER', KEYS[i], ARGV[2]) == 1 then return 'duplicate' end
end

local check = redis.call('EXISTS', KEYS[25]) == 0
for i = 14, 18 do
  if redis.call('EXISTS', KEYS[i]) == 1 then check = true end
end

append_like(check and '1' or '0')
local ttl = tonumber(ARGV[8])
if redis.call('EXISTS', KEYS[13]) == 0 then
  if redis.call('SCARD', KEYS[10]) >= tonumber(ARGV[9]) then
    redis.call('SET', KEYS[13], 1, 'EX', ttl)
  else
    redis.call('SADD', KEYS[10], ARGV[2])
    redis.call('EXPIRE', KEYS[10], ttl, 'NX')
  end
end
if ARGV[4] == '2' then
  -- Kept apart from the cap: super likes are few, and the target sees them first.
  redis.call('SADD', KEYS[24], ARGV[2])
  redis.call('EXPIRE', KEYS[24], ttl, 'NX')
end
if check then return 'check' end
return 'liked'
