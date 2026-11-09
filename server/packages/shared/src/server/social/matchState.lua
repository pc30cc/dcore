-- Caches a conversation's state (mt:<id>) read from PostgreSQL, unless it
-- may be stale:
-- - the conversation ended (mte:<id>): every end leaves its tombstone before
--   it drops the state, so a state read just before an end (a block, an
--   unmatch, a ban, a deletion) is never put back;
-- - a writer changed what the copy holds a moment ago (mtf:<id>, a few
--   seconds: call consent, a person's visibility) and dropped it: a read
--   made before that change is not put back either; the next read after the
--   fence caches again.
-- Every writer of mt: but the announcement of a new match (matchAnnounce.lua)
-- and the write-through of a committed change (matchChanged.lua), which both
-- check the same tombstone, comes through here.
--
-- A copy's lifetime is only ever extended: a writer that keeps its copy
-- briefly (a call's read) never shortens the one a chat read keeps.
--
-- KEYS[1] mt:<id>  KEYS[2] mte:<id>  KEYS[3] mtf:<id>
-- ARGV lo, hi, state, flags, source, creation ms, lifetime (s),
-- visibility ('' keeps the one stored).
-- Returns 1 when cached, 0 when the conversation ended, -1 while fenced.
if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
if redis.call('EXISTS', KEYS[3]) == 1 then return -1 end
-- -2: no copy yet, -1: a copy without a lifetime.
local left = redis.call('PTTL', KEYS[1])
redis.call('HSET', KEYS[1], 'lo', ARGV[1], 'hi', ARGV[2], 'st', ARGV[3], 'fl', ARGV[4], 'src', ARGV[5], 'at', ARGV[6])
if ARGV[8] ~= '' then redis.call('HSET', KEYS[1], 'vis', ARGV[8]) end
local ttl = tonumber(ARGV[7])
if left < ttl * 1000 then redis.call('EXPIRE', KEYS[1], ttl) end
return 1
