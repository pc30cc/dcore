-- Adds swiped people to a person's seen filter of one 15-day period: a
-- scalable Bloom filter in three tiers of growing size. Tier 0 takes the
-- first cap0 entries of the period, tier 1 the next cap1, tier 2 the next
-- cap2; past that the period is full (bot-like volume) and nothing is added.
--
-- KEYS[1..3]: the period's tiers (0, :x, :y). KEYS[4]: the period's counter.
-- ARGV[1]: lifetime of the keys in seconds (set once, when a key is made).
-- ARGV[2..4]: cap0, cap1, cap2. ARGV[5]: k (bit positions per entry).
-- ARGV[6]: the number of entries n. Then, for each entry, 3 * k positions:
-- k for tier 0, k for tier 1, k for tier 2 (each tier has its own size).
-- An entry already in some tier is not added again (and not counted).
-- Returns {added, count}: entries added, and the period's count after them.
local ttl = tonumber(ARGV[1])
local caps = { tonumber(ARGV[2]), tonumber(ARGV[3]), tonumber(ARGV[4]) }
local k = tonumber(ARGV[5])
local n = tonumber(ARGV[6])
local count = tonumber(redis.call('GET', KEYS[4]) or '0')
local added = 0

local function present(tier, base)
  for i = 1, k do
    if redis.call('GETBIT', KEYS[tier], ARGV[base + (tier - 1) * k + i]) == 0 then return false end
  end
  return true
end

for e = 0, n - 1 do
  local base = 6 + e * 3 * k
  local known = false
  for tier = 1, 3 do
    if present(tier, base) then known = true break end
  end
  if not known then
    local tier = 0
    if count < caps[1] then tier = 1
    elseif count < caps[1] + caps[2] then tier = 2
    elseif count < caps[1] + caps[2] + caps[3] then tier = 3 end
    if tier == 0 then break end
    local args = {}
    for i = 1, k do
      args[#args + 1] = 'SET'
      args[#args + 1] = 'u1'
      args[#args + 1] = ARGV[base + (tier - 1) * k + i]
      args[#args + 1] = 1
    end
    redis.call('BITFIELD', KEYS[tier], unpack(args))
    redis.call('EXPIRE', KEYS[tier], ttl, 'NX')
    count = count + 1
    added = added + 1
  end
end

if added > 0 then
  redis.call('SET', KEYS[4], count, 'KEEPTTL')
  redis.call('EXPIRE', KEYS[4], ttl, 'NX')
end
return { added, count }
