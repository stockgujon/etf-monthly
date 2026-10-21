// 用 node --import 載入：把 globalThis.fetch 換成模擬世界，並記錄每個請求
import { appendFileSync } from 'node:fs';
import { handle } from './mock-world.mjs';

globalThis.fetch = async (url, init = {}) => {
  if (process.env.MOCK_LOG) appendFileSync(process.env.MOCK_LOG, `${init.method || 'GET'} ${url}\n`);
  const { status, body } = handle(String(url), init);
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
};
