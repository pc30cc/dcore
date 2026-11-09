-- A reader's pointers in one conversation, only ever forward. The read
-- pointer goes to `rp:<m>` (and the conversation into `rp:dirty`, which the
-- flush job writes to PostgreSQL once a minute) and pulls the delivered
-- pointer along; the reader's unread count of the conversation is set to 0
-- once the read pointer reaches its newest message (kept as 0, not deleted:
-- a list rebuilt from PostgreSQL before the flush would otherwise count again
-- what was just read, from the database's older pointer); the conversation is
-- marked as on screen for push suppression. The delivered pointer lives in
-- `dl:<m>` only. A pointer past `ARGV[7]` (an id minted now) is clamped to it.
--
-- KEYS[1] rp:<m>  KEYS[2] rp:dirty  KEYS[3] dl:<m>  KEYS[4] unr:<reader>
-- KEYS[5] lm:<m>  KEYS[6] view:<reader>
--
-- ARGV[1] the reader's side ('lo' or 'hi'), ARGV[2] read up to (or ''),
-- ARGV[3] delivered up to (or ''), ARGV[4] the match id, ARGV[5] rp:
-- lifetime (s), ARGV[6] dl: lifetime (s), ARGV[7] the largest id allowed,
-- ARGV[8] view: lifetime (s), ARGV[9] unr: lifetime (s).
--
-- Returns {read moved to (or ''), delivered moved to (or ''), the read
-- pointer, the delivered pointer}.

local function newer(a, b)
  if #a ~= #b then return #a > #b end
  return a > b
end

local function clamp(id)
  if newer(id, ARGV[7]) then return ARGV[7] end
  return id
end

local side = ARGV[1]
local readMoved = ''
local deliveredMoved = ''
local read = redis.call('HGET', KEYS[1], side) or ''
local delivered = redis.call('HGET', KEYS[3], side) or ''

if ARGV[2] ~= '' then
  local upTo = clamp(ARGV[2])
  if read == '' or newer(upTo, read) then
    redis.call('HSET', KEYS[1], side, upTo)
    redis.call('EXPIRE', KEYS[1], tonumber(ARGV[5]))
    redis.call('SADD', KEYS[2], ARGV[4])
    read = upTo
    readMoved = upTo
  end
  local last = redis.call('HGET', KEYS[5], 'id')
  if (not last) or not newer(last, read) then
    redis.call('HSET', KEYS[4], ARGV[4], 0)
    redis.call('EXPIRE', KEYS[4], tonumber(ARGV[9]))
  end
  redis.call('SET', KEYS[6], ARGV[4], 'EX', tonumber(ARGV[8]))
end

local wanted = ''
if ARGV[3] ~= '' then wanted = clamp(ARGV[3]) end
-- What was read was delivered.
if read ~= '' and (wanted == '' or newer(read, wanted)) then wanted = read end
if wanted ~= '' and (delivered == '' or newer(wanted, delivered)) then
  redis.call('HSET', KEYS[3], side, wanted)
  redis.call('EXPIRE', KEYS[3], tonumber(ARGV[6]))
  delivered = wanted
  if ARGV[3] ~= '' then deliveredMoved = wanted end
end

return {readMoved, deliveredMoved, read, delivered}
