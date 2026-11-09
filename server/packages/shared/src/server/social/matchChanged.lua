-- A writer changed what a conversation's cached state holds and committed it
-- (the call consent or the mute of one of its two people): the copy takes
-- the new flags at once (a stored visibility stays), and a fence refuses for
-- a few seconds every state read before the change, so a reader that raced
-- the change never puts the old flags back. While the fence of another
-- change stands, the new flags are written only over the very flags this
-- change was made from (the other change is then already in them); else the
-- order of the two is unknown, the copy is dropped, and the next read after
-- the fence caches again.
--
-- KEYS[1] mt:<id>  KEYS[2] mte:<id>  KEYS[3] mtf:<id>
-- ARGV lo, hi, state, flags, source, creation ms, lifetime (s), fence (s),
-- the flags the change was made from.
-- Returns 1 when written, 0 when the conversation ended, -1 when dropped.
if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
local fence = tonumber(ARGV[8])
if redis.call('EXISTS', KEYS[3]) == 1 then
  local held = redis.call('HMGET', KEYS[1], 'lo', 'fl')
  if not held[1] or held[2] ~= ARGV[9] then
    redis.call('DEL', KEYS[1])
    redis.call('SET', KEYS[3], 1, 'EX', fence)
    return -1
  end
end
redis.call('HSET', KEYS[1], 'lo', ARGV[1], 'hi', ARGV[2], 'st', ARGV[3], 'fl', ARGV[4], 'src', ARGV[5], 'at', ARGV[6])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[7]))
redis.call('SET', KEYS[3], 1, 'EX', fence)
return 1
