-- The ring push of a call and its stop, kept in order: FCM keeps none, so a
-- stop sent while its ring is still on its way can arrive first and leave a
-- phone ringing for a call that is over. The call hash says where the ring
-- is (`rp`): absent (not started), 'sending:<ms>', 'sent' (with `rung`, the
-- devices it went to), 'stopped' (stopped before it started: it never
-- starts), 'cancelled' (stopped after it was sent).
--
-- KEYS[1] call:<id>
-- ARGV[1] the step: 'begin', 'done', 'stop' or 'force'
-- ARGV[2] now (ms)  ARGV[3] (done) the rung devices as JSON
--
--   begin: {'go'} when the ring may be sent now (the call still rings, with
--          ring left, and rings somebody), else {'skip', state}
--   done:  {'done', state}: the call's state after the ring was sent
--   stop:  {'none'} nothing to stop, {'wait', since} the ring is on its way,
--          {'send', rung, answered device} the stop to send now
--   force: as 'stop', for a ring whose sender went quiet: {'send', '', ...}
local h = KEYS[1]
local step = ARGV[1]
local st = redis.call('HGET', h, 'st')
if not st then return { 'none' } end
local rp = redis.call('HGET', h, 'rp')

if step == 'begin' then
  if rp then return { 'skip', rp } end
  local now = tonumber(ARGV[2])
  local due = tonumber(redis.call('HGET', h, 'pl')) + tonumber(redis.call('HGET', h, 'rd'))
  if st ~= 'ringing' or now >= due or redis.call('HEXISTS', h, 'fk') == 1 then
    redis.call('HSET', h, 'rp', 'stopped')
    return { 'skip', st }
  end
  redis.call('HSET', h, 'rp', 'sending:' .. ARGV[2])
  return { 'go' }
end

if step == 'done' then
  if rp and string.sub(rp, 1, 8) == 'sending:' then
    redis.call('HSET', h, 'rp', 'sent', 'rung', ARGV[3])
  end
  return { 'done', st }
end

-- stop, force
if not rp then
  redis.call('HSET', h, 'rp', 'stopped')
  return { 'none' }
end
if rp == 'stopped' or rp == 'cancelled' then return { 'none' } end
if string.sub(rp, 1, 8) == 'sending:' and step == 'stop' then
  return { 'wait', string.sub(rp, 9) }
end
local rung = redis.call('HGET', h, 'rung') or ''
if string.sub(rp, 1, 8) == 'sending:' then rung = '' end
redis.call('HSET', h, 'rp', 'cancelled')
return { 'send', rung, redis.call('HGET', h, 'ad') or '' }
