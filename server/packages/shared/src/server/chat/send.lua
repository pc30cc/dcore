-- A chat message, in one step: the conversation must be active and the
-- sender one of its two people (its cached state `mt:<m>`, and no end
-- tombstone `mte:<m>`, so a send racing an unmatch or a block is either
-- before it or refused); a client id seen in the last 15 minutes answers
-- with the message it made then; otherwise the message is appended to the
-- write-behind stream with its pre-minted id, its record kept for retries,
-- and the conversation list state moved: the newest message (only by a
-- newer id), both lists' order, the recipient's unread count and both list
-- versions.
--
-- KEYS[1] mte:<m>   KEYS[2] mt:<m>    KEYS[3] idem:msg:<uid>:<clientId>
-- KEYS[4] wb:msg    KEYS[5] lm:<m>    KEYS[6] cl:<lo>   KEYS[7] cl:<hi>
-- KEYS[8] unr:<lo>  KEYS[9] unr:<hi>  KEYS[10] cv:<lo>  KEYS[11] cv:<hi>
--
-- ARGV[1] message id, ARGV[2] match id, ARGV[3] sender id, ARGV[4] kind
-- code, ARGV[5] ref id or '', ARGV[6] flags, ARGV[7] body, ARGV[8] '1' when
-- there is a body, ARGV[9] the message's time (ms), ARGV[10] its preview,
-- ARGV[11] its effect on the lists ('news', 'reaction', 'unsend'),
-- ARGV[12] '1' when the other person receives it (else only the sender's
-- side moves), ARGV[13] the record a retry gets back, ARGV[14] the record's
-- lifetime (s), ARGV[15] lm: lifetime (s), ARGV[16] lists' lifetime (s),
-- ARGV[17] now (ms, for the versions).
--
-- Returns {'sent', <stream id>, <side>}, {'replay', <record>},
-- {'ended'}, {'nostate'} (not cached: read it and try again) or
-- {'notmember'}.

local function newer(a, b)
  if #a ~= #b then return #a > #b end
  return a > b
end

local function bump(key, now, ttl)
  local current = tonumber(redis.call('GET', key) or '')
  local nextValue = now
  if current and current >= now then nextValue = current + 1 end
  redis.call('SET', key, nextValue, 'EX', ttl)
end

if redis.call('EXISTS', KEYS[1]) == 1 then return {'ended'} end
local state = redis.call('HMGET', KEYS[2], 'lo', 'hi', 'st')
if not state[1] or not state[2] then return {'nostate'} end
if state[3] ~= '1' then return {'ended'} end
local sender = ARGV[3]
local side
if state[1] == sender then side = 'lo' elseif state[2] == sender then side = 'hi' else return {'notmember'} end

local prior = redis.call('GET', KEYS[3])
if prior then return {'replay', prior} end

local fields = {'id', ARGV[1], 'm', ARGV[2], 's', sender, 'k', ARGV[4], 'r', ARGV[5], 'f', ARGV[6]}
if ARGV[8] == '1' then
  fields[#fields + 1] = 'b'
  fields[#fields + 1] = ARGV[7]
end
local streamId = redis.call('XADD', KEYS[4], '*', unpack(fields))
redis.call('SET', KEYS[3], ARGV[13], 'EX', tonumber(ARGV[14]))

local effect = ARGV[11]
local both = ARGV[12] == '1'
local now = tonumber(ARGV[17])
local listTtl = tonumber(ARGV[16])
local last = redis.call('HGET', KEYS[5], 'id')
local moves = false
if effect == 'news' then
  moves = (not last) or newer(ARGV[1], last)
elseif effect == 'unsend' then
  -- Taking back the newest message makes the unsend the preview.
  moves = last and last == ARGV[5]
end
if moves then
  redis.call('HSET', KEYS[5], 'id', ARGV[1], 's', sender, 'k', ARGV[4], 'r', ARGV[5], 'f', ARGV[6], 'p', ARGV[10])
  redis.call('EXPIRE', KEYS[5], tonumber(ARGV[15]))
end
if effect == 'news' or moves then
  for i = 6, 7 do
    local own = (i == 6 and side == 'lo') or (i == 7 and side == 'hi')
    if own or both then
      redis.call('ZADD', KEYS[i], 'GT', tonumber(ARGV[9]), ARGV[2])
      redis.call('EXPIRE', KEYS[i], listTtl)
    end
  end
end
if effect == 'news' and both then
  local unread = KEYS[9]
  if side == 'hi' then unread = KEYS[8] end
  redis.call('HINCRBY', unread, ARGV[2], 1)
  redis.call('EXPIRE', unread, listTtl)
end
if effect == 'news' or moves then
  if side == 'lo' or both then bump(KEYS[10], now, listTtl) end
  if side == 'hi' or both then bump(KEYS[11], now, listTtl) end
end
return {'sent', streamId, side}
