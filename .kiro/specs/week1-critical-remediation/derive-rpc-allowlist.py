#!/usr/bin/env python3
"""
Derives which database functions actually need to be callable by the `authenticated` role,
by finding every .rpc() call in the app and classifying the client that makes it.

This is the input to task 21.4. The allow-list has to come from the call sites, not from
reading function names and guessing, because a revoke that is too wide breaks a money path
silently and one that is too narrow leaves the hole open.

Classification per call site:
  browser  a client component, so the caller is the end user's session
  session  a server route using createServerClient, still the user's session and RLS
  service  a server route using the service role, which bypasses grants entirely

Anything reached only by `service` can be revoked from anon and authenticated.
Anything reached by `browser` or `session` must stay granted, or move behind a server route.

Usage: python3 derive-rpc-allowlist.py [repo_root]
"""
import os
import re
import sys
import json
from collections import defaultdict

ROOT = sys.argv[1] if len(sys.argv) > 1 else os.getcwd()
SRC = os.path.join(ROOT, 'frontend', 'src')

# Receiver can be a variable (`supabase.rpc`), a zero-arg helper call (`moneyDb().rpc`),
# or a parenthesised fallback (`(adminDb() ?? supabase).rpc`).
RPC = re.compile(
    r'(?:(?P<helper>\w+)\s*\(\s*\)\s*\.\s*|(?P<var>\w+)\s*\.\s*)?rpc\s*\(\s*[\'"](?P<fn>[a-zA-Z0-9_]+)[\'"]'
)
SERVICE_HINT = re.compile(r'SUPABASE_SERVICE_ROLE_KEY')
# `const admin = createClient(url, SERVICE_ROLE_KEY)` and the helper-call form
# `const admin = serviceClient()` / `adminDb()`.
ASSIGN = re.compile(r'(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+)?(\w+)?\s*\(?')

SERVICE_HELPERS = {'serviceClient', 'adminDb', 'admin', 'svc', 'serviceRole', 'adminClient',
                   'moneyDb', 'serviceDb'}
SESSION_HELPERS = {'createServerClient', 'userClient', 'sessionClient'}
BROWSER_HELPERS = {'createBrowserClient'}


def classify_file(path, text):
    """Best-effort map of variable name to client kind for one file."""
    kinds = {}
    is_client_component = "'use client'" in text[:400] or '"use client"' in text[:400]
    in_api_route = f'{os.sep}app{os.sep}api{os.sep}' in path

    for line in text.splitlines():
        m = ASSIGN.search(line)
        if not m:
            continue
        var, callee = m.group(1), (m.group(2) or '')
        if 'createBrowserClient' in line or (callee == 'createClient' and 'lib/supabase' in text and not in_api_route and is_client_component):
            kinds[var] = 'browser'
        elif 'createServerClient' in line:
            kinds[var] = 'session'
        elif SERVICE_HINT.search(line) or callee in SERVICE_HELPERS:
            kinds[var] = 'service'

    # Multi-line createClient(...) blocks, including the lazy-singleton form used in lib/
    # where the assignment has no const/let: `_client = createClient(url, serviceKey, ...)`.
    for m in re.finditer(r'(?:(?:const|let|var)\s+)?(\w+)\s*=\s*(?:await\s+)?createClient\s*\((.{0,400}?)\)', text, re.S):
        if SERVICE_HINT.search(m.group(2)):
            kinds[m.group(1)] = 'service'
    # A lib module that only ever builds a service client has no user-session path, so its
    # local accessor (commonly db()/admin()) is service too.
    if SERVICE_HINT.search(text) and 'createServerClient' not in text and 'use client' not in text[:400]:
        for m in re.finditer(r'function\s+(\w+)\s*\(', text):
            kinds.setdefault(m.group(1), 'service')
        for m in re.finditer(r'(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+)?(\w+)\s*\(\s*\)', text):
            if kinds.get(m.group(2)) == 'service':
                kinds[m.group(1)] = 'service'
    for m in re.finditer(r'(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+)?createServerClient\s*\(', text):
        kinds[m.group(1)] = 'session'

    if is_client_component:
        default = 'browser'
    elif in_api_route:
        default = 'session'
    elif SERVICE_HINT.search(text) and 'createServerClient' not in text:
        default = 'service'
    else:
        default = 'unknown'
    return kinds, default, is_client_component


def main():
    calls = defaultdict(list)
    for dirpath, _dirs, files in os.walk(SRC):
        for fn in files:
            if not fn.endswith(('.ts', '.tsx')):
                continue
            path = os.path.join(dirpath, fn)
            with open(path, encoding='utf8', errors='replace') as fh:
                text = fh.read()
            if 'rpc(' not in text:
                continue
            kinds, default, _ = classify_file(path, text)
            rel = os.path.relpath(path, ROOT)
            for i, line in enumerate(text.splitlines(), 1):
                for m in RPC.finditer(line):
                    helper, var, fname = m.group('helper'), m.group('var'), m.group('fn')
                    if helper:
                        recv = helper
                        kind = 'service' if helper in SERVICE_HELPERS else kinds.get(helper, default)
                    elif var:
                        recv = var
                        kind = kinds.get(var, default)
                    else:
                        recv = None
                        kind = default
                    calls[fname].append({'file': rel, 'line': i, 'var': recv, 'kind': kind})

    summary = {}
    for fname, sites in sorted(calls.items()):
        kinds = {s['kind'] for s in sites}
        if 'browser' in kinds:
            verdict = 'BROWSER, must be allow-listed or moved server-side'
        elif 'session' in kinds:
            verdict = 'USER SESSION, must stay granted to authenticated'
        elif kinds == {'service'}:
            verdict = 'service only, safe to revoke'
        else:
            verdict = f'UNCLEAR ({sorted(kinds)}), inspect'
        summary[fname] = {'verdict': verdict, 'sites': sites}

    order = {'BROWSER': 0, 'USER': 1, 'UNCLEAR': 2, 'service': 3}
    def rank(item):
        return order.get(item[1]['verdict'].split(',')[0].split(' ')[0], 9)

    print(f'{len(summary)} distinct functions called from the app\n')
    for fname, info in sorted(summary.items(), key=rank):
        print(f'{fname}')
        print(f'    {info["verdict"]}')
        for s in info['sites']:
            v = s['var'] or '(bare)'
            print(f'      {s["kind"]:8} {v:12} {s["file"]}:{s["line"]}')
        print()

    counts = defaultdict(int)
    for info in summary.values():
        counts[info['verdict'].split(',')[0]] += 1
    print('--- totals ---')
    for k, v in sorted(counts.items()):
        print(f'  {v:3}  {k}')

    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'rpc-allowlist.json'), 'w') as fh:
        json.dump(summary, fh, indent=2)
    print('\nwrote rpc-allowlist.json')


if __name__ == '__main__':
    main()
