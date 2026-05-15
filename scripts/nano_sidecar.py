"""
Bima Agent — Nano Sidecar
Wraps nano-memory + nano-guard as a single FastAPI HTTP server.
Port: 8769 (configurable via NANO_SIDECAR_PORT env var)
"""
import os
import sys
import json
import logging
from typing import Optional

# Add nano source paths so we don't need pip install
_NANO_PATHS = [
    os.path.expanduser('~/Desktop/github projects/nano-memory'),
    os.path.expanduser('~/Desktop/github projects/nano-guard'),
]
for _p in _NANO_PATHS:
    if os.path.isdir(_p) and _p not in sys.path:
        sys.path.insert(0, _p)

from fastapi import FastAPI, HTTPException, Query
from pydantic import BaseModel
import uvicorn

logging.basicConfig(level=logging.WARNING)
log = logging.getLogger('nano_sidecar')

app = FastAPI(title='Bima Nano Sidecar', docs_url=None, redoc_url=None)

# ── Lazy-loaded singletons ─────────────────────────────────────
_guard = None
_memory_instances: dict = {}

def _get_guard():
    global _guard
    if _guard is None:
        from nano_guard import Guard
        _guard = Guard()
    return _guard

def _get_memory(namespace: str):
    if namespace not in _memory_instances:
        from nano_memory import Memory, MemoryConfig, StoreConfig
        cfg = MemoryConfig(
            namespace=namespace,
            store=StoreConfig(
                path=os.path.expanduser('~/.bima/nano-memory')
            ),
        )
        _memory_instances[namespace] = Memory(cfg)
    return _memory_instances[namespace]

# ── Models ─────────────────────────────────────────────────────
class AddTurnReq(BaseModel):
    namespace: str
    role: str       # 'user' | 'assistant'
    content: str

class ScanReq(BaseModel):
    text: str

# ── Health ─────────────────────────────────────────────────────
@app.get('/health')
def health():
    return {'status': 'ok', 'service': 'bima-nano-sidecar'}

# ── Memory endpoints ───────────────────────────────────────────
@app.post('/memory/add')
def memory_add(req: AddTurnReq):
    try:
        mem = _get_memory(req.namespace)
        text = f'{req.role}: {req.content}'
        mem.save(text, type='episode')
        return {'ok': True}
    except Exception as e:
        log.error('memory_add error: %s', e)
        raise HTTPException(500, str(e))

@app.get('/memory/history')
def memory_history(
    namespace: str = Query(...),
    limit: int = Query(20),
):
    try:
        mem = _get_memory(namespace)
        records = mem.list()  # ordered by insertion time
        # Take last `limit` records and parse back to {role, content}
        recent = records[-limit:] if len(records) > limit else records
        history = []
        for r in recent:
            text = getattr(r, 'text', str(r))
            if text.startswith('user: '):
                history.append({'role': 'user', 'content': text[6:]})
            elif text.startswith('assistant: '):
                history.append({'role': 'assistant', 'content': text[11:]})
            else:
                history.append({'role': 'user', 'content': text})
        return {'history': history}
    except Exception as e:
        log.error('memory_history error: %s', e)
        raise HTTPException(500, str(e))

@app.get('/memory/recall')
def memory_recall(
    namespace: str = Query(...),
    query: str = Query(...),
    top_k: int = Query(5),
):
    """Semantic recall — find most relevant past turns for a query."""
    try:
        mem = _get_memory(namespace)
        records = mem.search(query, top_k=top_k)
        results = []
        for r in records:
            text = getattr(r, 'text', str(r))
            results.append({'text': text, 'score': getattr(r, 'score', 0.0)})
        return {'results': results}
    except Exception as e:
        log.error('memory_recall error: %s', e)
        raise HTTPException(500, str(e))

@app.delete('/memory/clear')
def memory_clear(namespace: str = Query(...)):
    try:
        mem = _get_memory(namespace)
        count = mem.clear()
        if namespace in _memory_instances:
            del _memory_instances[namespace]
        return {'cleared': count}
    except Exception as e:
        log.error('memory_clear error: %s', e)
        raise HTTPException(500, str(e))

# ── Guard endpoints ────────────────────────────────────────────
@app.post('/guard/scan')
def guard_scan(req: ScanReq):
    try:
        guard = _get_guard()
        result = guard.scan(req.text)
        categories = []
        if result.violations:
            for v in result.violations:
                t = getattr(v, 'type', None) or getattr(v, 'category', None) or str(v)
                if t and t not in categories:
                    categories.append(str(t))
        return {
            'blocked': result.blocked,
            'categories': categories,
            'redacted_text': result.redacted_text,
            'scan_ms': result.scan_ms,
        }
    except Exception as e:
        log.error('guard_scan error: %s', e)
        # Don't crash on guard errors — return clean
        return {
            'blocked': False,
            'categories': [],
            'redacted_text': req.text,
            'scan_ms': 0,
            'error': str(e),
        }

# ── Entry ──────────────────────────────────────────────────────
if __name__ == '__main__':
    port = int(os.environ.get('NANO_SIDECAR_PORT', '8769'))
    host = os.environ.get('NANO_SIDECAR_HOST', '127.0.0.1')
    print(f'[nano-sidecar] Starting on {host}:{port}', flush=True)
    uvicorn.run(app, host=host, port=port, log_level='error', access_log=False)
