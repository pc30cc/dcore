#!/usr/bin/env python3
"""Checks the in-country media relay the way a participant's phone uses it.

    probe.py check <relay host> <port> udp|tcp
    probe.py serve <bind address> <port> [seconds]

check: allocates on the relay with a time-limited credential (coturn's
use-auth-secret, the TURN REST scheme), asks for permission to the media
server, sends STUN Binding requests to it through the relay and reads the
answers, then checks that any other peer is refused, so nobody can use the
relay as an open one.

  The credential is either minted here from the shared secret, exactly as the
  API mints them (username <expiry>:r<16 random hex>, password
  base64(HMAC-SHA1(secret, username))), or taken as it is from a call token's
  answer, to check precisely what a phone was given:

    TURN_SECRET_FILE      file holding the relay's shared secret (read, never
                          printed; neither is the password made from it)
    TURN_CREDENTIAL_FILE  instead: a JSON file {"username": ..., "credential": ...}
                          (the `turn` object of a call token answer)

  PEER_IP      the media server the relay must reach (required: LiveKit's node)
  PEER_PORT    where on it a plain STUN Binding is answered (default 3478). The
               media ports answer STUN only inside a call, so run `serve` there
               while checking (on a free port, inside the media range to check
               that range's firewall too).
  DENIED_PEER  a peer the relay must refuse (default 1.1.1.1)
  PINGS        Binding requests sent through the relay (default 5)

serve: answers STUN Binding requests on UDP for a while (default 120 s), so
`check` has something to reach on the media server's host.

Exit status: 0 when every check passes, 1 when one fails, 2 on bad usage.
Standard library only, so it runs as it is on any server.
"""
import base64
import hashlib
import hmac
import json
import os
import secrets
import socket
import statistics
import struct
import sys
import time
import zlib

MAGIC = 0x2112A442

# STUN and TURN methods (RFC 8489, RFC 8656).
BINDING = 0x001
ALLOCATE = 0x003
REFRESH = 0x004
SEND = 0x006
DATA = 0x007
CREATE_PERMISSION = 0x008

# Message classes.
REQUEST, INDICATION, SUCCESS, ERROR = 0, 1, 2, 3

# Attributes.
MAPPED_ADDRESS = 0x0001
USERNAME = 0x0006
MESSAGE_INTEGRITY = 0x0008
ERROR_CODE = 0x0009
LIFETIME = 0x000D
XOR_PEER_ADDRESS = 0x0012
DATA_ATTR = 0x0013
REALM = 0x0014
NONCE = 0x0015
XOR_RELAYED_ADDRESS = 0x0016
REQUESTED_TRANSPORT = 0x0019
XOR_MAPPED_ADDRESS = 0x0020
FINGERPRINT = 0x8028

UDP_PROTOCOL = 17
# A minted probe credential lives as long as a check needs, not hours.
PROBE_CREDENTIAL_SECONDS = 600


class ProbeError(Exception):
    pass


def message_type(method, cls):
    return ((method & 0xF80) << 2) | ((method & 0x070) << 1) | (method & 0x00F) \
        | ((cls & 0x2) << 7) | ((cls & 0x1) << 4)


def split_message_type(value):
    method = (value & 0x000F) | ((value >> 1) & 0x0070) | ((value >> 2) & 0x0F80)
    cls = ((value >> 4) & 0x1) | ((value >> 7) & 0x2)
    return method, cls


def attribute(kind, value):
    return struct.pack('!HH', kind, len(value)) + value + b'\0' * ((-len(value)) % 4)


def encode(method, cls, txid, attrs, key=None):
    """A STUN message: MESSAGE-INTEGRITY when a key is given, FINGERPRINT always."""
    kind = message_type(method, cls)
    body = b''.join(attrs)
    if key is not None:
        # While it is computed, the header's length covers the message up to
        # and including MESSAGE-INTEGRITY (RFC 8489 §14.5).
        head = struct.pack('!HHI', kind, len(body) + 24, MAGIC) + txid
        body += attribute(MESSAGE_INTEGRITY, hmac.new(key, head + body, hashlib.sha1).digest())
    head = struct.pack('!HHI', kind, len(body) + 8, MAGIC) + txid
    crc = (zlib.crc32(head + body) ^ 0x5354554E) & 0xFFFFFFFF
    body += attribute(FINGERPRINT, struct.pack('!I', crc))
    return struct.pack('!HHI', kind, len(body), MAGIC) + txid + body


class Message:
    def __init__(self, method, cls, txid, attrs):
        self.method = method
        self.cls = cls
        self.txid = txid
        self.attrs = attrs

    def error(self):
        """(code, reason) of an error response, else None."""
        value = self.attrs.get(ERROR_CODE)
        if self.cls != ERROR or value is None or len(value) < 4:
            return None
        return (value[2] & 0x7) * 100 + value[3], value[4:].decode('utf-8', 'replace').strip()


def decode(data):
    """A STUN message, or None for anything else (ChannelData, noise)."""
    if len(data) < 20:
        return None
    kind, length, magic = struct.unpack('!HHI', data[:8])
    if magic != MAGIC or kind & 0xC000 or len(data) < 20 + length:
        return None
    method, cls = split_message_type(kind)
    txid = data[8:20]
    attrs = {}
    i, end = 20, 20 + length
    while i + 4 <= end:
        kind, size = struct.unpack('!HH', data[i:i + 4])
        attrs.setdefault(kind, data[i + 4:i + 4 + size])
        i += 4 + size + ((-size) % 4)
    return Message(method, cls, txid, attrs)


def xor_address(ip, port, txid):
    try:
        raw, family = socket.inet_pton(socket.AF_INET, ip), 1
        mask = struct.pack('!I', MAGIC)
    except OSError:
        raw, family = socket.inet_pton(socket.AF_INET6, ip), 2
        mask = struct.pack('!I', MAGIC) + txid
    xored = bytes(a ^ b for a, b in zip(raw, mask))
    return struct.pack('!BBH', 0, family, port ^ (MAGIC >> 16)) + xored


def read_xor_address(value, txid):
    if value is None or len(value) < 8:
        return None
    family = value[1]
    port = struct.unpack('!H', value[2:4])[0] ^ (MAGIC >> 16)
    if family == 1:
        raw = bytes(a ^ b for a, b in zip(value[4:8], struct.pack('!I', MAGIC)))
        return socket.inet_ntop(socket.AF_INET, raw), port
    if family == 2 and len(value) >= 20:
        raw = bytes(a ^ b for a, b in zip(value[4:20], struct.pack('!I', MAGIC) + txid))
        return socket.inet_ntop(socket.AF_INET6, raw), port
    return None


def read_plain_address(value):
    if value is None or len(value) < 8:
        return None
    port = struct.unpack('!H', value[2:4])[0]
    if value[1] == 1:
        return socket.inet_ntop(socket.AF_INET, value[4:8]), port
    if value[1] == 2 and len(value) >= 20:
        return socket.inet_ntop(socket.AF_INET6, value[4:20]), port
    return None


def show(address):
    ip, port = address
    return ('[%s]:%d' if ':' in ip else '%s:%d') % (ip, port)


class Connection:
    """One connection to the relay: a connected UDP socket, or TCP with STUN framing."""

    def __init__(self, host, port, transport):
        self.tcp = transport == 'tcp'
        kind = socket.SOCK_STREAM if self.tcp else socket.SOCK_DGRAM
        try:
            family, _, _, _, address = socket.getaddrinfo(host, port, 0, kind)[0]
            self.sock = socket.socket(family, kind)
            self.sock.settimeout(8)
            self.sock.connect(address)
        except OSError as err:
            raise ProbeError('cannot reach %s:%d over %s: %s' % (host, port, transport, err))
        self.buffer = b''

    def send(self, data):
        try:
            self.sock.sendall(data)
        except OSError as err:
            raise ProbeError('send failed: %s' % err)

    def receive(self, deadline):
        """The next STUN message from the relay, or None once the deadline passes."""
        while True:
            if self.tcp:
                frame = self._next_frame()
                if frame is not None:
                    message = decode(frame)
                    if message is not None:
                        return message
                    continue
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None
            self.sock.settimeout(remaining)
            try:
                data = self.sock.recv(65536)
            except socket.timeout:
                return None
            except ConnectionRefusedError:
                # A connected UDP socket reports an ICMP "port unreachable" here.
                raise ProbeError('the relay refused the connection (nothing listens on that port, or a firewall rejects it)')
            except OSError as err:
                raise ProbeError('receive failed: %s' % err)
            if self.tcp:
                if not data:
                    raise ProbeError('the relay closed the TCP connection')
                self.buffer += data
                continue
            message = decode(data)
            if message is not None:
                return message

    def _next_frame(self):
        if len(self.buffer) < 4:
            return None
        length = struct.unpack('!H', self.buffer[2:4])[0]
        if 0x40 <= self.buffer[0] <= 0x7F:
            # ChannelData, padded to 4 bytes over TCP (RFC 8656 §12.5): not
            # used here (no channel is bound), but it must not break framing.
            size = 4 + length + ((-length) % 4)
        else:
            size = 20 + length
        if len(self.buffer) < size:
            return None
        frame, self.buffer = self.buffer[:size], self.buffer[size:]
        return frame

    def transact(self, method, attrs, key=None):
        """A request and its answer (matched by transaction id), or None when none came."""
        txid = os.urandom(12)
        data = encode(method, REQUEST, txid, attrs, key)
        # UDP retransmits with a doubling wait (RFC 8489 §6.2.1); TCP sends once.
        waits = (8.0,) if self.tcp else (0.5, 1.0, 2.0, 4.0)
        for wait in waits:
            self.send(data)
            deadline = time.monotonic() + wait
            while True:
                message = self.receive(deadline)
                if message is None:
                    break
                if message.txid == txid and message.cls in (SUCCESS, ERROR):
                    return message
        return None

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


def mint_credential(secret):
    """A credential as the API mints them (turnAuth): <expiry>:r<16 hex> and its HMAC."""
    expiry = int(time.time()) + PROBE_CREDENTIAL_SECONDS
    username = ('%d:r%s' % (expiry, secrets.token_hex(8))).encode()
    return username, base64.b64encode(hmac.new(secret, username, hashlib.sha1).digest())


class Allocation:
    """An allocation on the relay under one credential."""

    def __init__(self, connection, username, password):
        self.c = connection
        self.username = username
        self.password = password
        self.realm = None
        self.nonce = None
        self.key = None

    def _auth(self):
        return [attribute(USERNAME, self.username), attribute(REALM, self.realm), attribute(NONCE, self.nonce)]

    def request(self, method, attrs):
        """An authenticated request; a stale nonce (438) is renewed once."""
        message = None
        for _ in range(2):
            message = self.c.transact(method, attrs + self._auth(), self.key)
            if message is None:
                return None
            err = message.error()
            if err and err[0] == 438 and NONCE in message.attrs:
                self.nonce = message.attrs[NONCE]
                continue
            return message
        return message

    def allocate(self):
        transport = [attribute(REQUESTED_TRANSPORT, struct.pack('!B3x', UDP_PROTOCOL))]
        first = self.c.transact(ALLOCATE, transport)
        if first is None:
            raise ProbeError('allocate: no answer from the relay')
        if first.cls == SUCCESS:
            raise ProbeError('allocate: accepted WITHOUT credentials, the relay is open (use-auth-secret missing)')
        err = first.error()
        if not err or err[0] != 401 or REALM not in first.attrs or NONCE not in first.attrs:
            raise ProbeError('allocate: unexpected answer %s' % (err,))
        self.realm = first.attrs[REALM]
        self.nonce = first.attrs[NONCE]
        # The long-term credential key (RFC 8489 §9.2.2): MD5(username:realm:password).
        self.key = hashlib.md5(self.username + b':' + self.realm + b':' + self.password).digest()
        message = self.request(ALLOCATE, transport)
        if message is None:
            raise ProbeError('allocate: no answer to the signed request')
        err = message.error()
        if err:
            hint = ''
            if err[0] == 401:
                hint = ' (not the relay\'s secret, an expired credential, or this clock far from the relay\'s)'
            elif err[0] == 486:
                hint = ' (the relay\'s total-quota, or user-quota for this username, is reached)'
            elif err[0] == 508:
                hint = ' (the relay has no relay port left)'
            raise ProbeError('allocate FAILED: %d %s%s' % (err[0], err[1], hint))
        relayed = read_xor_address(message.attrs.get(XOR_RELAYED_ADDRESS), message.txid)
        mapped = read_xor_address(message.attrs.get(XOR_MAPPED_ADDRESS), message.txid)
        lifetime = message.attrs.get(LIFETIME)
        if relayed is None:
            raise ProbeError('allocate: the answer has no relayed address')
        return relayed, mapped, struct.unpack('!I', lifetime)[0] if lifetime and len(lifetime) == 4 else None

    def permission(self, ip):
        """None when granted, else the error (code, reason)."""
        # IPv4 only: an IPv6 XOR-PEER-ADDRESS is masked with the request's own
        # transaction id, which transact() makes, and the media server is IPv4.
        if ':' in ip:
            raise ProbeError('only IPv4 peers are checked (%s)' % ip)
        message = self.request(CREATE_PERMISSION, [attribute(XOR_PEER_ADDRESS, xor_address(ip, 0, b''))])
        if message is None:
            return (0, 'no answer')
        return message.error()

    def ping(self, ip, port, wait=2.0):
        """A STUN Binding to the peer through the relay: (round trip in seconds, the address it saw) or None."""
        inner_txid = os.urandom(12)
        inner = encode(BINDING, REQUEST, inner_txid, [])
        send_txid = os.urandom(12)
        # A Send indication carries no credentials (RFC 8656 §11): the
        # permission is what lets it out.
        self.c.send(encode(SEND, INDICATION, send_txid, [
            attribute(XOR_PEER_ADDRESS, xor_address(ip, port, send_txid)),
            attribute(DATA_ATTR, inner),
        ]))
        started = time.monotonic()
        deadline = started + wait
        while True:
            message = self.c.receive(deadline)
            if message is None:
                return None
            if message.method != DATA or message.cls != INDICATION:
                continue
            peer = read_xor_address(message.attrs.get(XOR_PEER_ADDRESS), message.txid)
            answer = decode(message.attrs.get(DATA_ATTR) or b'')
            if peer is None or peer[0] != ip or answer is None or answer.txid != inner_txid:
                continue
            seen = read_xor_address(answer.attrs.get(XOR_MAPPED_ADDRESS), answer.txid) \
                or read_plain_address(answer.attrs.get(MAPPED_ADDRESS))
            return time.monotonic() - started, seen

    def release(self):
        # Best effort: a lifetime of 0 frees the allocation now, so probes do
        # not eat into the relay's quota.
        try:
            self.request(REFRESH, [attribute(LIFETIME, struct.pack('!I', 0))])
        except ProbeError:
            pass


def env_int(name, default):
    value = os.environ.get(name, '').strip()
    if not value:
        return default
    try:
        return int(value)
    except ValueError:
        raise ProbeError('%s must be a number' % name)


def read_private_file(path, what):
    try:
        with open(path, 'rb') as handle:
            mode = os.fstat(handle.fileno()).st_mode
            raw = handle.read()
    except OSError as err:
        raise ProbeError('cannot read %s: %s' % (what, err))
    if mode & 0o077:
        print('warning: %s can be read by more than its owner (chmod 600 it)' % path, file=sys.stderr)
    return raw


def credential_from_environment():
    """(username, password) from TURN_CREDENTIAL_FILE, or minted from TURN_SECRET_FILE."""
    credential_file = os.environ.get('TURN_CREDENTIAL_FILE', '').strip()
    if credential_file:
        try:
            given = json.loads(read_private_file(credential_file, 'TURN_CREDENTIAL_FILE'))
            username, credential = given['username'], given['credential']
        except (ValueError, KeyError, TypeError):
            raise ProbeError('TURN_CREDENTIAL_FILE must hold {"username": ..., "credential": ...}')
        if not isinstance(username, str) or not isinstance(credential, str) or not username or not credential:
            raise ProbeError('TURN_CREDENTIAL_FILE must hold {"username": ..., "credential": ...}')
        return username.encode(), credential.encode()
    secret_file = os.environ.get('TURN_SECRET_FILE', '').strip()
    if not secret_file:
        raise ProbeError('set TURN_SECRET_FILE (the relay\'s shared secret) or TURN_CREDENTIAL_FILE')
    # configure.sh writes the file's content into coturn's configuration
    # with CR and LF removed; the same bytes here.
    secret = read_private_file(secret_file, 'TURN_SECRET_FILE').replace(b'\r', b'').replace(b'\n', b'')
    if not secret:
        raise ProbeError('TURN_SECRET_FILE is empty')
    return mint_credential(secret)


def check(host, port, transport):
    ok = True
    connection = None
    try:
        username, password = credential_from_environment()
        peer_ip = os.environ.get('PEER_IP', '').strip()
        if not peer_ip:
            raise ProbeError('set PEER_IP to the media server\'s address (LiveKit\'s node IP)')
        peer_port = env_int('PEER_PORT', 3478)
        denied = os.environ.get('DENIED_PEER', '').strip() or '1.1.1.1'
        pings = max(1, env_int('PINGS', 5))

        connection = Connection(host, port, transport)
        allocation = Allocation(connection, username, password)
        del password

        relayed, mapped, lifetime = allocation.allocate()
        print('allocate ok: relayed address %s, the relay sees us as %s, lifetime %s s' % (
            show(relayed), show(mapped) if mapped else '?', lifetime if lifetime is not None else '?'))

        err = allocation.permission(peer_ip)
        if err:
            ok = False
            print('permission to %s: REFUSED %d %s (is it in configure.sh\'s PEER_IPS?)' % (peer_ip, err[0], err[1]))
        else:
            print('permission to %s: ok' % peer_ip)
            rtts, seen = [], None
            for _ in range(pings):
                got = allocation.ping(peer_ip, peer_port)
                if got:
                    rtts.append(got[0])
                    seen = got[1] or seen
            if rtts:
                print('%s answered %d/%d (median %d ms), saw us as %s' % (
                    peer_ip, len(rtts), pings, round(statistics.median(rtts) * 1000), show(seen) if seen else '?'))
            else:
                ok = False
                print('%s answered 0/%d on port %d: the relay cannot reach it over UDP (is `serve` running there?)' % (peer_ip, pings, peer_port))

        err = allocation.permission(denied)
        if err and err[0] == 403:
            print('permission to %s (must be refused): REFUSED 403' % denied)
        elif err:
            ok = False
            print('permission to %s (must be refused): unexpected answer %d %s' % (denied, err[0], err[1]))
        else:
            ok = False
            print('permission to %s (must be refused): ACCEPTED, the relay forwards to any peer (denied-peer-ip missing)' % denied)

        allocation.release()
    except ProbeError as err:
        ok = False
        print(str(err))
    finally:
        if connection is not None:
            connection.close()
    return 0 if ok else 1


def serve(address, port, seconds):
    """Answers STUN Binding requests with the address they came from, for `seconds`."""
    family = socket.AF_INET6 if ':' in address else socket.AF_INET
    sock = socket.socket(family, socket.SOCK_DGRAM)
    try:
        sock.bind((address, port))
    except OSError as err:
        print('cannot listen on %s:%d: %s' % (address, port, err))
        return 1
    print('answering STUN Binding on %s for %d s' % (show(sock.getsockname()[:2]), seconds), flush=True)
    deadline = time.monotonic() + seconds
    answered = 0
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        sock.settimeout(remaining)
        try:
            data, sender = sock.recvfrom(2048)
        except socket.timeout:
            break
        message = decode(data)
        if message is None or message.method != BINDING or message.cls != REQUEST:
            continue
        reply = encode(BINDING, SUCCESS, message.txid, [attribute(XOR_MAPPED_ADDRESS, xor_address(sender[0], sender[1], message.txid))])
        sock.sendto(reply, sender)
        answered += 1
    sock.close()
    print('answered %d Binding request(s)' % answered)
    return 0


def main(argv):
    usage = ('usage: %(p)s check <relay host> <port> udp|tcp\n'
             '       %(p)s serve <bind address> <port> [seconds]') % {'p': os.path.basename(argv[0])}
    if len(argv) >= 4 and argv[1] == 'check' and len(argv) == 5 and argv[4] in ('udp', 'tcp'):
        try:
            return check(argv[2], int(argv[3]), argv[4])
        except ValueError:
            print('the port must be a number', file=sys.stderr)
            return 2
    if len(argv) in (4, 5) and argv[1] == 'serve':
        try:
            return serve(argv[2], int(argv[3]), int(argv[4]) if len(argv) == 5 else 120)
        except ValueError:
            print('the port and the seconds must be numbers', file=sys.stderr)
            return 2
    print(usage, file=sys.stderr)
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv))
