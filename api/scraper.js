import Router from 'router';
import cors from 'cors';
import rateLimit from "express-rate-limit";
import requestIp from 'request-ip';
import userAgentParser from 'ua-parser-js';
import { createClient } from 'redis'
import { RedisStore } from 'rate-limit-redis'
import addonInterface from '../scraper/addon.js';
import qs from 'querystring';
import { manifest } from '../scraper/lib/manifest.js';
import { parseConfiguration } from '../scraper/lib/configuration.js';
import landingTemplate from '../scraper/lib/landingTemplate.js';
import * as moch from '../scraper/moch/moch.js';

const router = new Router();

// Optional Redis client for rate limiting
let client;
let limiter = (req, res, next) => next();

if (process.env.REDIS_URL) {
  client = createClient({
    url: process.env.REDIS_URL,
  })
  await client.connect()
  limiter = rateLimit({
    windowMs: 24 * 60 * 60 * 1000, // 1 day
    limit: 5000,
    legacyHeaders: false,
    passOnStoreError: true,
    keyGenerator: (req) => requestIp.getClientIp(req),
    store: new RedisStore({
      sendCommand: (...args) => client.sendCommand(args),
    }),
  })
}

router.use(cors())

router.get('/stream/:type/:id.json', limiter, (req, res, next) => {
  handleStream(req, res, next);
});

router.get('/stream/:type/:id/:extra.json', limiter, (req, res, next) => {
  handleStream(req, res, next);
});

router.get('/c/:configuration/stream/:type/:id.json', limiter, (req, res, next) => {
  handleStream(req, res, next);
});

router.get('/c/:configuration/stream/:type/:id/:extra.json', limiter, (req, res, next) => {
  handleStream(req, res, next);
});

function handleStream(req, res, next) {
  const { configuration, type, id } = req.params;
  const extra = req.params.extra ? qs.parse(req.url.split('/').pop().slice(0, -5)) : {}
  const ip = requestIp.getClientIp(req);
  const host = `${req.protocol}://${req.headers.host}`;
  const configValues = { ...extra, ...parseConfiguration(configuration || ''), id, type, ip, host };
  
  addonInterface.get('stream', type, id, configValues)
      .then(resp => {
        const cacheHeaders = {
          cacheMaxAge: 'max-age',
          staleRevalidate: 'stale-while-revalidate',
          staleError: 'stale-if-error'
        };
        const cacheControl = Object.keys(cacheHeaders)
            .map(prop => Number.isInteger(resp[prop]) && cacheHeaders[prop] + '=' + resp[prop])
            .filter(val => !!val).join(', ');

        res.setHeader('Cache-Control', `${cacheControl || 'max-age=3600'}, public`);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(resp));
      })
      .catch(err => {
        if (err.noHandler) {
          res.writeHead(404);
          res.end(JSON.stringify({ err: 'not found' }));
        } else {
          console.error(err);
          res.writeHead(500);
          res.end(JSON.stringify({ err: 'handler error' }));
        }
      });
}

export default function (req, res) {
  router(req, res, function () {
    res.statusCode = 404;
    res.end();
  });
};
