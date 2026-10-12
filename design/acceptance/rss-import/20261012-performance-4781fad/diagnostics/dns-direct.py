import datetime
import ipaddress
import json
import secrets
import socket
import struct

HOST = 'castloop-test.otftalk.com'
SERVER = '1.1.1.1'

def skip_name(data, offset):
    while True:
        length = data[offset]
        if length & 0xc0 == 0xc0:
            return offset + 2
        offset += 1
        if length == 0:
            return offset
        offset += length

def receive_exact(sock, count):
    result = b''
    while len(result) < count:
        chunk = sock.recv(count - len(result))
        if not chunk:
            raise RuntimeError('DNS TCP connection closed')
        result += chunk
    return result

def query(record_type, transport):
    identity = secrets.randbelow(65536)
    name = b''.join(bytes([len(part)]) + part.encode('ascii') for part in HOST.split('.')) + b'\0'
    packet = struct.pack('!6H', identity, 0x0100, 1, 0, 0, 0) + name + struct.pack('!2H', record_type, 1)
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM if transport == 'UDP' else socket.SOCK_STREAM) as sock:
        sock.settimeout(10)
        sock.connect((SERVER, 53))
        if transport == 'UDP':
            sock.send(packet)
            data = sock.recv(65535)
        else:
            sock.sendall(struct.pack('!H', len(packet)) + packet)
            size = struct.unpack('!H', receive_exact(sock, 2))[0]
            data = receive_exact(sock, size)
    ident, flags, questions, answers, _, _ = struct.unpack_from('!6H', data)
    assert ident == identity and flags & 0x8000, 'Unexpected DNS response'
    offset = 12
    for _ in range(questions):
        offset = skip_name(data, offset) + 4
    addresses = []
    for _ in range(answers):
        offset = skip_name(data, offset)
        kind, klass, ttl, size = struct.unpack_from('!HHIH', data, offset)
        offset += 10
        value = data[offset:offset + size]
        offset += size
        if klass == 1 and kind in (1, 28):
            addresses.append({'type': 'A' if kind == 1 else 'AAAA', 'address': str(ipaddress.ip_address(value)), 'ttl': ttl})
    return {'rcode': flags & 0xf, 'truncated': bool(flags & 0x0200), 'answer_count': answers, 'addresses': addresses}

if __name__ == '__main__':
    result = {'timestamp': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'hostname': HOST, 'dns_server': SERVER, 'queries': []}
    for transport in ['UDP', 'TCP']:
        for kind in [1, 28]:
            item = {'transport': transport, 'type': 'A' if kind == 1 else 'AAAA'}
            try:
                item.update(query(kind, transport))
            except (OSError, ValueError, RuntimeError, AssertionError, struct.error, IndexError) as error:
                item['error'] = str(error)
            result['queries'].append(item)
    print(json.dumps(result, indent=2))
