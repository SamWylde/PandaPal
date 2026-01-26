import os
import sys
import time
import asyncio
import httpx

# Add the catalog directory to path to reach lib and other modules
catalog_path = os.path.join(os.path.dirname(__file__), '..', 'catalog')
sys.path.append(catalog_path)

from fastapi import FastAPI, HTTPException, Request, BackgroundTasks
from builder import Builder
from catalog_list import CatalogList
from lib import log

app = FastAPI()

# Vercel has 300s max, leave buffer for HTTP overhead
MAX_EXECUTION_TIME_SEC = 270
# Process fewer catalogs per batch to stay within timeout
DEFAULT_CHUNK_SIZE = 5

async def trigger_next_chunk(base_url: str, chunk_index: int, chunk_size: int, auth_header: str = None):
    """Trigger the next chunk asynchronously"""
    try:
        url = f"{base_url}/api/crawl?chunk={chunk_index}&size={chunk_size}"
        headers = {}
        if auth_header:
            headers["Authorization"] = auth_header

        async with httpx.AsyncClient(timeout=10.0) as client:
            # Fire and forget - don't wait for response
            await client.get(url, headers=headers)
            log.info(f"::=>[Crawler] Triggered next chunk {chunk_index}")
    except Exception as e:
        log.error(f"::=>[Crawler] Failed to trigger next chunk: {e}")

@app.get("/api/crawl")
async def crawl(request: Request, background_tasks: BackgroundTasks):
    start_time = time.time()

    # Security check: Ensure this is triggered by Vercel Cron or someone with the right secret
    cron_secret = os.environ.get("CRON_SECRET")
    auth_header = request.headers.get("Authorization")

    if cron_secret:
        if not auth_header or auth_header != f"Bearer {cron_secret}":
            raise HTTPException(status_code=401, detail="Unauthorized")
    else:
        log.warning("::=>[Crawler] CRON_SECRET is not set. Anyone can trigger the crawl!")

    # Optional parameters for chunked crawling
    try:
        chunk_index = int(request.query_params.get("chunk", 0))
        chunk_size = int(request.query_params.get("size", DEFAULT_CHUNK_SIZE))
        auto_continue = request.query_params.get("auto", "true").lower() == "true"
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid chunk or size parameters")

    try:
        configs = CatalogList.get_catalog_configs()
        total_catalogs = len(configs)
        total_chunks = (total_catalogs + chunk_size - 1) // chunk_size

        # Calculate start and end indices
        start_idx = chunk_index * chunk_size
        if start_idx >= total_catalogs:
            return {
                "status": "complete",
                "message": "All catalogs already processed.",
                "total": total_catalogs,
                "chunks_total": total_chunks
            }

        end_idx = min(start_idx + chunk_size, total_catalogs)
        chunk_configs = configs[start_idx:end_idx]

        log.info(f"::=>[Crawler] Processing chunk {chunk_index + 1}/{total_chunks} (catalogs {start_idx + 1}-{end_idx} of {total_catalogs})")

        # Trigger the build process for the chunk
        Builder().build(configs=chunk_configs)

        elapsed = time.time() - start_time
        has_more = end_idx < total_catalogs

        log.info(f"::=>[Crawler] Chunk {chunk_index + 1} completed in {elapsed:.1f}s")

        # Auto-trigger next chunk if there's more to process and we have time
        if has_more and auto_continue:
            # Get base URL for self-triggering
            base_url = str(request.base_url).rstrip('/')
            if not base_url.startswith('http'):
                base_url = f"https://{request.headers.get('host', 'localhost')}"

            # Schedule next chunk in background
            background_tasks.add_task(
                trigger_next_chunk,
                base_url,
                chunk_index + 1,
                chunk_size,
                auth_header
            )
            log.info(f"::=>[Crawler] Scheduling chunk {chunk_index + 2}/{total_chunks}")

        return {
            "status": "success" if has_more else "complete",
            "message": f"Crawled catalogs {start_idx + 1} to {end_idx}",
            "chunk": chunk_index + 1,
            "chunks_total": total_chunks,
            "processed": len(chunk_configs),
            "total": total_catalogs,
            "elapsed_seconds": round(elapsed, 1),
            "next_chunk": chunk_index + 1 if has_more else None,
            "auto_continuing": has_more and auto_continue
        }
    except Exception as e:
        log.error(f"Error during crawl: {e}")
        raise HTTPException(status_code=500, detail=str(e))
