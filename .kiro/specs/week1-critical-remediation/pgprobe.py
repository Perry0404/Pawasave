"""
Finds which Supabase pooler region hosts a project.

psql was timing out rather than reporting, which hid the server's actual message. This
completes the TLS handshake and sends a real StartupMessage, then reads the reply. The pooler
answers 'Tenant or user not found' for the wrong region, so whichever gets as far as
authentication is the right one.

Usage: python3 pgprobe.py <project-ref>
"""
import socket
import ssl
import struct
import sys

REF = sys.argv[1]
REGIONS = [
    'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
    'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-1', 'eu-central-2', 'eu-north-1',
    'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1', 'ap-northeast-2', 'ap-south-1',
    'sa-east-1', 'ca-central-1',
]


def read_msgs(sock, budget=6.0):
    sock.settimeout(budget)
    out = []
    buf = b''
    try:
        while True:
            chunk = sock.recv(4096)
            if not chunk:
                break
            buf += chunk
            while len(buf) >= 5:
                mtype = buf[0:1]
                (mlen,) = struct.unpack('!I', buf[1:5])
                if len(buf) < 1 + mlen:
                    break
                out.append((mtype, buf[5:1 + mlen]))
                buf = buf[1 + mlen:]
            if any(t in (b'E', b'R', b'Z') for t, _ in out):
                break
    except socket.timeout:
        pass
    return out


def probe(region):
    host = f'aws-0-{region}.pooler.supabase.com'
    try:
        raw = socket.create_connection((host, 5432), timeout=8)
    except Exception as e:
        return f'connect failed: {e}'
    try:
        raw.sendall(struct.pack('!II', 8, 80877103))
        raw.settimeout(8)
        if raw.recv(1) != b'S':
            raw.close()
            return 'server refused SSL'

        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        sock = ctx.wrap_socket(raw, server_hostname=host)

        params = b''
        for k, v in [('user', f'postgres.{REF}'), ('database', 'postgres')]:
            params += k.encode() + b'\0' + v.encode() + b'\0'
        params += b'\0'
        body = struct.pack('!I', 196608) + params
        sock.sendall(struct.pack('!I', len(body) + 4) + body)

        msgs = read_msgs(sock)
        sock.close()
        if not msgs:
            return 'no response'
        for mtype, payload in msgs:
            if mtype == b'E':
                fields = {}
                for part in payload.split(b'\0'):
                    if len(part) > 1:
                        fields[part[0:1].decode('latin1')] = part[1:].decode('latin1', 'replace')
                return 'ERROR: ' + fields.get('M', str(fields))
            if mtype == b'R':
                (method,) = struct.unpack('!I', payload[:4])
                names = {0: 'AUTH OK', 3: 'cleartext password', 5: 'md5', 10: 'SASL/SCRAM'}
                return f'REACHED AUTH ({names.get(method, method)})'
        return 'got ' + ','.join(t.decode() for t, _ in msgs)
    except Exception as e:
        try:
            raw.close()
        except Exception:
            pass
        return f'failed: {type(e).__name__}: {e}'


print(f'probing for project {REF}\n')
for r in REGIONS:
    res = probe(r)
    hit = res.startswith('REACHED AUTH')
    print(f'  {r:16} {res}{"   <<< THIS ONE" if hit else ""}')
    if hit:
        break
