import os
import sys

# Add the catalog directory to path to reach lib and other modules
catalog_path = os.path.join(os.path.dirname(__file__), '..', 'catalog')
sys.path.append(catalog_path)

from fastapi import FastAPI, HTTPException, Request
from builder import Builder
from catalog_list import CatalogList
from lib import log

app = FastAPI()

@app.get("/api/crawl")
async def crawl(request: Request):
    # Security check: Ensure this is triggered by Vercel Cron or someone with the right secret
    cron_secret = os.environ.get("CRON_SECRET")
    auth_header = request.headers.get("Authorization")
    
    if cron_secret:
        if not auth_header or auth_header != f"Bearer {cron_secret}":
            raise HTTPException(status_code=401, detail="Unauthorized")
    else:
        # Warning for logs, though for debugging it might be helpful to allow without secret
        log.warning("::=>[Crawler] CRON_SECRET is not set. Anyone can trigger the crawl!")

    # Optional parameters for chunked crawling
    try:
        chunk_index = int(request.query_params.get("chunk", 0))
        chunk_size = int(request.query_params.get("size", 10)) # Default to 10 catalogs per run
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid chunk or size parameters")

    try:
        configs = CatalogList.get_catalog_configs()
        total_catalogs = len(configs)
        
        # Calculate start and end indices
        start_idx = chunk_index * chunk_size
        if start_idx >= total_catalogs:
            return {"status": "success", "message": "All catalogs already processed for these parameters.", "total": total_catalogs}
            
        end_idx = min(start_idx + chunk_size, total_catalogs)
        chunk_configs = configs[start_idx:end_idx]
        
        log.info(f"::=>[Crawler] Processing chunk {chunk_index} (catalogs {start_idx}-{end_idx-1} of {total_catalogs})")
        
        # Trigger the build process for the chunk
        Builder().build(configs=chunk_configs)
        
        return {
            "status": "success", 
            "message": f"Crawled catalogs {start_idx} to {end_idx-1}",
            "processed": len(chunk_configs),
            "total": total_catalogs,
            "next_chunk": chunk_index + 1 if end_idx < total_catalogs else None
        }
    except Exception as e:
        log.error(f"Error during crawl: {e}")
        raise HTTPException(status_code=500, detail=str(e))
