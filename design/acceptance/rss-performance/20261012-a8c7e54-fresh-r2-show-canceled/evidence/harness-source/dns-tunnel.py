import importlib.util
import json
import os
from pathlib import Path
import select
import socket
import socketserver
import sys
import threading

HOST = os.environ.get('DOMAIN_HOST', 'castloop-test.otftalk.com')
spec = importlib.util.spec_from_file_location('dns_direct', Path(__file__).with_name('dns-direct.py'))
dns = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dns)
dns.HOST = HOST
lock = threading.Lock()

class Tunnel(socketserver.StreamRequestHandler):
    def handle(self):
        self.connection.settimeout(30)
        line = self.rfile.readline(4096).decode('ascii', errors='strict').strip()
        if line != f'CONNECT {HOST}:443 HTTP/1.1':
            self.wfile.write(b'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n')
            return
        size = len(line)
        while True:
            header = self.rfile.readline(4096)
            size += len(header)
            if size > 16384 or not header:
                return
            if header in [b'\r\n', b'\n']:
                break
        try:
            answer = dns.query(1, 'UDP')
            assert answer['rcode'] == 0 and not answer['truncated'] and answer['addresses']
            addresses = [item['address'] for item in answer['addresses'] if item['type'] == 'A']
            remote = None
            for address in addresses:
                try:
                    remote = socket.create_connection((address, 443), timeout=15)
                    break
                except OSError:
                    pass
            if remote is None:
                raise OSError('No upstream connection')
            with lock:
                with open(sys.argv[2], 'a') as log:
                    log.write(json.dumps({'dns_server': '1.1.1.1', 'hostname': HOST,
                        'connected_address': address, 'tls_terminated': False}) + '\n')
            with remote:
                self.wfile.write(b'HTTP/1.1 200 Connection Established\r\n\r\n')
                self.wfile.flush()
                self.connection.settimeout(None)
                remote.settimeout(None)
                sockets = [self.connection, remote]
                while True:
                    readable, _, _ = select.select(sockets, [], [], 180)
                    if not readable:
                        return
                    for source in readable:
                        data = source.recv(65536)
                        if not data:
                            return
                        (remote if source is self.connection else self.connection).sendall(data)
        except (OSError, ValueError, AssertionError, IndexError):
            try:
                self.wfile.write(b'HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n')
            except OSError:
                pass

class Server(socketserver.ThreadingTCPServer):
    daemon_threads = True

os.umask(0o077)
with Server(('127.0.0.1', 0), Tunnel) as server:
    Path(sys.argv[1]).write_text(json.dumps({'proxy_url': f'http://127.0.0.1:{server.server_address[1]}',
        'pid': os.getpid(), 'hostname': HOST, 'dns_server': '1.1.1.1', 'tls_terminated': False}) + '\n')
    server.serve_forever()
