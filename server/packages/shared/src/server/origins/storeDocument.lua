-- Keeps the newest signed origins document for the worker to publish.
--
-- KEYS[1]  origins:doc (hash: v version, t issuedAt ms, b process start ms, body)
-- ARGV[1]  version
-- ARGV[2]  issuedAt, ms
-- ARGV[3]  the start time (ms) of the process that signed it
-- ARGV[4]  the document, as served
--
-- Newest wins by (version, issuedAt), then by the later process start, so
-- an older API process (a rolling deploy, a reload it has not made yet)
-- never puts back what a newer one wrote. Returns 1 when stored, 0 when
-- the stored one is as new or newer.
local current = redis.call('HMGET', KEYS[1], 'v', 't', 'b')
local v = tonumber(current[1])
local t = tonumber(current[2])
local b = tonumber(current[3])
local nv = tonumber(ARGV[1])
local nt = tonumber(ARGV[2])
local nb = tonumber(ARGV[3])
if v ~= nil and t ~= nil then
  if nv < v then return 0 end
  if nv == v and nt < t then return 0 end
  if nv == v and nt == t and (b == nil or nb <= b) then return 0 end
end
redis.call('HSET', KEYS[1], 'v', ARGV[1], 't', ARGV[2], 'b', ARGV[3], 'body', ARGV[4])
return 1
