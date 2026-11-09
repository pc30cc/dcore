-- A new match into the Valkey state both people's lists read, unless its
-- conversation already ended: the end paths leave `mte:<id>` for an hour,
-- so an announcement that read the match before the end (the API's fast
-- path, the stream worker) cannot put it back into the lists.
--
-- KEYS[1] mt:<id>  KEYS[2] mte:<id>  KEYS[3] lkm:<lo>:<hi>
-- KEYS[4] cl:<lo>  KEYS[5] cl:<hi>
-- ARGV[1] lo, ARGV[2] hi, ARGV[3] state, ARGV[4] flags, ARGV[5] source,
-- ARGV[6] creation ms, ARGV[7] match id, ARGV[8] mt: lifetime (s),
-- ARGV[9] lkm: lifetime (s), ARGV[10] cl: lifetime (s).
--
-- The lists only ever take the match's creation time as its score when they
-- do not hold it yet (ZADD GT): an announcement repeated later (an accept
-- sent again, the stream worker after the API's fast path) never moves a
-- conversation with newer activity back.
--
-- Returns 1 when announced, 0 when the conversation had ended.

if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
redis.call('HSET', KEYS[1], 'lo', ARGV[1], 'hi', ARGV[2], 'st', ARGV[3], 'fl', ARGV[4], 'src', ARGV[5], 'at', ARGV[6])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[8]))
redis.call('SET', KEYS[3], 1, 'EX', tonumber(ARGV[9]))
for i = 4, 5 do
  redis.call('ZADD', KEYS[i], 'GT', tonumber(ARGV[6]), ARGV[7])
  redis.call('EXPIRE', KEYS[i], tonumber(ARGV[10]))
end
return 1
