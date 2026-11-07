-- Gives back one count on each counter in KEYS (when nothing was sent, so
-- the attempt should not use up a limit). Never below zero; windows stay.
for i = 1, #KEYS do
  local current = tonumber(redis.call('GET', KEYS[i]) or '0') or 0
  if current > 0 then redis.call('DECR', KEYS[i]) end
end
return 0
