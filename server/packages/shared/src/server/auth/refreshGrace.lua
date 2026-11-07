-- The refresh grace of one session (KEYS[1] rtg:<sid>, a hash): field =
-- hash of the refresh token that was used, value = "<deadline ms>|p" while
-- a refresh with it is in flight, "<deadline ms>|<sealed answer>" once it
-- answered. Each entry keeps its own deadline; the key lives as long as the
-- newest. KEYS[2]: the session's refresh counter (claim only).
--
-- claim:    ARGV: 'claim', token hash, in-flight ms, count (1/0), cap, window ms
--           → {'limited', ms} · {'done', answer} · {'pending'} · {'claimed'}
-- complete: ARGV: 'complete', token hash, grace ms, sealed answer → {'ok'}
-- release:  ARGV: 'release', token hash → {'ok'} (drops an in-flight entry only)
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local mode = ARGV[1]

local function read(field)
  local v = redis.call('HGET', KEYS[1], field)
  if not v then return nil end
  local sep = string.find(v, '|', 1, true)
  if not sep then return nil end
  local deadline = tonumber(string.sub(v, 1, sep - 1)) or 0
  if deadline <= now then return nil end
  return string.sub(v, sep + 1)
end

local function keep(ms)
  local ttl = redis.call('PTTL', KEYS[1])
  if ttl < ms then redis.call('PEXPIRE', KEYS[1], ms) end
end

if mode == 'claim' then
  if ARGV[4] == '1' then
    local n = redis.call('INCR', KEYS[2])
    if n == 1 then redis.call('PEXPIRE', KEYS[2], ARGV[6]) end
    if n > tonumber(ARGV[5]) then return {'limited', redis.call('PTTL', KEYS[2])} end
  end
  local body = read(ARGV[2])
  if body == 'p' then return {'pending'} end
  if body then return {'done', body} end
  local ms = tonumber(ARGV[3])
  redis.call('HSET', KEYS[1], ARGV[2], (now + ms) .. '|p')
  keep(ms)
  return {'claimed'}
elseif mode == 'complete' then
  local ms = tonumber(ARGV[3])
  redis.call('HSET', KEYS[1], ARGV[2], (now + ms) .. '|' .. ARGV[4])
  keep(ms)
  return {'ok'}
elseif mode == 'release' then
  local v = redis.call('HGET', KEYS[1], ARGV[2])
  if v and string.sub(v, -2) == '|p' then redis.call('HDEL', KEYS[1], ARGV[2]) end
  return {'ok'}
end
return redis.error_reply('unknown mode')
