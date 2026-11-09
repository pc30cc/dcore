-- The relay username of one participant of a call: the one handed before
-- while enough of it is left, else the new one, kept in the call hash. coturn
-- counts allocations per username and a username stays valid until the
-- expiry it carries, so a participant asking for tokens again and again
-- (every rejoin) must not collect a username each time.
--
-- KEYS[1] call:<id>
-- ARGV[1] the participant's field ('tcr' caller, 'tce' callee)
-- ARGV[2] the username just minted  ARGV[3] the earliest expiry (unix s) a kept one may have
-- Returns the username to hand out, or false when the call hash is gone.
if redis.call('EXISTS', KEYS[1]) == 0 then return false end
local kept = redis.call('HGET', KEYS[1], ARGV[1])
if kept then
  local expiry = tonumber(string.match(kept, '^(%d+):r%x+$') or '')
  if expiry and expiry >= tonumber(ARGV[3]) then
    redis.call('HSET', KEYS[1], 'rl', '1')
    return kept
  end
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2], 'rl', '1')
return ARGV[2]
