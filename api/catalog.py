import os
import sys

# Add the catalog directory to path to reach lib and other modules
current_dir = os.path.dirname(os.path.abspath(__file__))
catalog_path = os.path.join(os.path.abspath(os.path.join(current_dir, '..')), 'catalog')
sys.path.append(catalog_path)
sys.path.append(current_dir) # Also add api dir just in case

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.middleware.gzip import GZipMiddleware

# Disable background threads for serverless environment
# We might need to modify WebWorker to not start threads if possible, 
# or just ignore it since Vercel will kill the process anyway.

worker = None
try:
    from lib.web_worker import WebWorker
    worker = WebWorker(should_start_thread=False)
except Exception as e:
    print(f"CRITICAL ERROR: Failed to initialize WebWorker: {e}")

app = FastAPI()
app.add_middleware(GZipMiddleware, minimum_size=1000)

CACHE_DURATIONS = {
    "SHORT": 60 * 15,       # 15 minutes
    "MEDIUM": 60 * 60 * 4,  # 4 hours
    "LONG": 60 * 60 * 24,   # 24 hours
    "VERY_LONG": 60 * 60 * 24 * 7  # 7 days
}

def add_cache_headers(max_age: int) -> dict:
    return {
        "Cache-Control": f"public, max-age={max_age}, stale-while-revalidate={max_age // 2}, stale-if-error={max_age * 2}",
        "Vary": "Accept-Encoding"
    }

def __json_response(data: dict, extra_headers: dict[str, str] = {}, status_code: int = 200):
    response = JSONResponse(data, status_code=status_code)
    headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "*",
    }
    headers.update(extra_headers)
    response.headers.update(headers)
    return response

@app.get("/api/catalog/health")
async def health_check():
    return JSONResponse({"status": "ok"}, status_code=200)

@app.get("/catalog/{type}/{id}.json")
@app.get("/catalog/{type}/{id}/{extras}.json")
@app.get("/c/{configs}/catalog/{type}/{id}.json")
@app.get("/c/{configs}/catalog/{type}/{id}/{extras}.json")
async def catalog_endpoint(
    type: str, id: str, configs: str | None = None, extras: str | None = None
):
    if id is None:
        raise HTTPException(status_code=404, detail="Not found")

    if worker is None:
        return __json_response({"metas": [], "error": "Catalog service unavailable (missing credentials)"})

    metas = await worker.get_configured_catalog(id=id, extras=extras, config=configs)
    headers = add_cache_headers(CACHE_DURATIONS["MEDIUM"])
    return __json_response(metas, extra_headers=headers)

@app.get("/meta/{type}/{id}.json")
@app.get("/c/{configs}/meta/{type}/{id}.json")
async def meta_endpoint(type: str, id: str, configs: str | None = None):
    if id is None or type is None:
        raise HTTPException(status_code=404, detail="Not found")
    
    if worker is None:
        return __json_response({"meta": {}, "error": "Meta service unavailable"})

    meta = worker.get_meta(id=id, s_type=type, config=configs)
    headers = add_cache_headers(CACHE_DURATIONS["VERY_LONG"])
    return __json_response(meta, extra_headers=headers)

@app.get("/catalog/manifest.json")
@app.get("/c/{configs}/catalog/manifest.json")
async def manifest_endpoint(request: Request, configs: str | None = None):
    referer = str(request.base_url)
    if worker is None:
        return __json_response({"catalogs": [], "id": "pandapal.catalog", "name": "PandaPal Catalog (Unavailable)"})
    manifest = worker.get_configured_manifest(referer, configs)
    headers = add_cache_headers(CACHE_DURATIONS["SHORT"])
    return __json_response(manifest, extra_headers=headers)
