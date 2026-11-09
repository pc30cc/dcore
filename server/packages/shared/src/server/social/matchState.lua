-- Caches a conversation's state (mt:<id>) read from PostgreSQL, unless it
-- may be stale:
-- - the conversation ended (mte:<id>): every end leaves its tombstone before
--   it drops the state, so a state read just before an end (a block, an
--   unmatch, a ban, a deletion) is never put back;
-- - a writer changed what the copy holds a moment ago (mtf:<id>, a few
--   seconds: call consent, a person's visibility) and dropped it: a read
--   made before that change is not put back either; the next read after the
--   fence caches again.
-- Every writer of mt: but the announcement of a new match (matchAnnounce.lua,
-- which checks the same tombstone) comes through here.
--
-- KEYS[1] mt:<id>  KEYS[2] mte:<id>  KEYS[3] mtf:<id>
-- ARGV lo, hi, state, flags, source, creation ms, lifetime (s),
-- visibility ('' keeps the one stored).
-- Returns 1 when cached, 0 when the conversation ended, -1 while fenced.
if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
if redis.call('EXISTS', KEYS[3]) == 1 then return -1 end
redis.call('HSET', KEYS[1], 'lo', ARGV[1], 'hi', ARGV[2], 'st', ARGV[3], 'fl', ARGV[4], 'src', ARGV[5], 'at', ARGV[6])
if ARGV[8] ~= '' then redis.call('HSET', KEYS[1], 'vis', ARGV[8]) end
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[7]))
return 1
