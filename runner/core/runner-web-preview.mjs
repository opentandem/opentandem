/** Zero-dependency loopback transport, also embedded in the standalone Runner. */
export function createRunnerWebPreview({ verifyTicket, machineId }) {
  const wpSessions = new Map();
  const wpPending = new Set();
  const wpLimit = 16 * 1024 * 1024;
  const wpWsLimit = 8 * 1024 * 1024;
  let wpClosed = false;
  const wpHop = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length']);
  const wpSensitive = new Set(['proxy-authorization', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip']);
  function wpCleanHeaders(wpInput, wpResponse = false) {
    wpInput = Object.fromEntries((Array.isArray(wpInput) ? wpInput : Object.entries(wpInput || {})).map(([wpName, wpValue]) => [String(wpName).toLowerCase(), wpValue]));
    const wpResult = {};
    const wpConnection = String(wpInput?.connection || wpInput?.Connection || '').toLowerCase().split(',').map(wpValue => wpValue.trim());
    for (const [wpName, wpValue] of Object.entries(wpInput || {})) {
      const wpKey = wpName.toLowerCase();
      if (wpHop.has(wpKey) || wpConnection.includes(wpKey) || wpKey === 'set-cookie' || (!wpResponse && (wpSensitive.has(wpKey) || wpKey.startsWith('sec-') || wpKey.startsWith('x-opentandem-')))) continue;
      if (typeof wpValue === 'string' && !/[\r\n\0]/.test(wpValue)) wpResult[wpKey] = wpValue;
      else if (wpResponse && Array.isArray(wpValue)) wpResult[wpKey] = wpValue.join(', ');
    }
    return wpResult;
  }
  function wpPath(wpRaw, wpPort) {
    if (typeof wpRaw !== 'string' || !wpRaw.startsWith('/') || wpRaw.startsWith('//') || /[\u0000-\u0020\u007f\\]/.test(wpRaw)) throw new Error('Invalid preview path');
    const wpOrigin = `http://127.0.0.1:${wpPort}`;
    const wpUrl = new URL(wpRaw, wpOrigin);
    if (wpUrl.origin !== new URL(wpOrigin).origin || wpUrl.hash) throw new Error('Invalid preview origin');
    return wpUrl.pathname + wpUrl.search;
  }
  function wpPrune(wpSession) {
    clearTimeout(wpSession.timer);
    for (const wpSocket of wpSession.sockets.values()) wpSocket.destroy();
    for (const wpStream of wpSession.streams.values()) wpStream.destroy();
    for (const wpReq of wpSession.requests) wpReq.destroy(new Error('Preview session expired'));
    wpSessions.delete(wpSession.jti);
  }
  async function wpAuthorize(wpTask, wpTicket) {
    if (wpClosed) throw new Error('Preview transport closed');
    const wpClaims = await verifyTicket(wpTicket);
    if (!wpClaims || wpClaims.use !== 'web-preview' || wpClaims.mid !== machineId || wpClaims.task !== wpTask || typeof wpTask !== 'string' || !Number.isFinite(wpClaims.exp) || wpClaims.exp <= Date.now() || !Number.isInteger(wpClaims.port) || wpClaims.port < 1 || wpClaims.port > 65535 || typeof wpClaims.jti !== 'string' || !wpClaims.jti || wpClaims.jti.length > 256) throw new Error('Invalid preview ticket');
    if (wpClosed) throw new Error('Preview transport closed');
    let wpSession = wpSessions.get(wpClaims.jti);
    if (wpSession && (wpSession.task !== wpTask || wpSession.port !== wpClaims.port)) throw new Error('Preview ticket binding mismatch');
    if (!wpSession) {
      if (wpSessions.size >= 128) throw new Error('Too many preview sessions');
      wpSession = { jti: wpClaims.jti, task: wpTask, port: wpClaims.port, exp: wpClaims.exp, cookies: new Map(), sockets: new Map(), streams: new Map(), requests: new Set() };
      wpSessions.set(wpClaims.jti, wpSession);
      wpSession.timer = setTimeout(() => wpPrune(wpSession), Math.min(wpClaims.exp - Date.now(), 2147483647));
      wpSession.timer.unref?.();
    }
    if (wpClaims.exp > wpSession.exp) {
      wpSession.exp = wpClaims.exp;
      clearTimeout(wpSession.timer);
      wpSession.timer = setTimeout(() => wpPrune(wpSession), Math.min(wpClaims.exp - Date.now(), 2147483647));
      wpSession.timer.unref?.();
    }
    return wpSession;
  }
  function wpSaveCookies(wpSession, wpHeaders, wpRequestPath) {
    const wpVisible = [];
    for (const wpCookie of wpHeaders['set-cookie'] || []) {
      if (wpCookie.length > 8192) continue;
      const wpParts = wpCookie.split(';').map(wpPart => wpPart.trim());
      const wpPair = wpParts.shift();
      const wpIndex = wpPair.indexOf('=');
      if (wpIndex <= 0) continue;
      const wpName = wpPair.slice(0, wpIndex);
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(wpName)) continue;
      const wpAttrs = new Map(wpParts.map(wpPart => { const wpI = wpPart.indexOf('='); return wpI < 0 ? [wpPart.toLowerCase(), ''] : [wpPart.slice(0, wpI).toLowerCase(), wpPart.slice(wpI + 1)]; }));
      const wpDomain = (wpAttrs.get('domain') || '').replace(/^\./, '').toLowerCase();
      if (wpDomain && wpDomain !== '127.0.0.1') continue;
      const wpBasePath = wpRequestPath.split('?')[0];
      const wpPathValue = wpAttrs.get('path')?.startsWith('/') ? wpAttrs.get('path') : wpBasePath.slice(0, wpBasePath.lastIndexOf('/')) || '/';
      const wpKey = wpName + '\n' + wpPathValue;
      let wpExpires = wpAttrs.has('expires') ? Date.parse(wpAttrs.get('expires')) : Infinity;
      if (wpAttrs.has('max-age') && /^-?\d+$/.test(wpAttrs.get('max-age'))) wpExpires = Date.now() + Number(wpAttrs.get('max-age')) * 1000;
      if (!Number.isFinite(wpExpires)) wpExpires = Infinity;
      if (wpExpires <= Date.now()) wpSession.cookies.delete(wpKey);
      else if (wpSession.cookies.size < 128 || wpSession.cookies.has(wpKey)) wpSession.cookies.set(wpKey, { name: wpName, pair: wpPair, path: wpPathValue, httpOnly: wpAttrs.has('httponly'), expires: wpExpires });
      if (!wpAttrs.has('httponly')) wpVisible.push([wpPair, ...wpParts.filter(wpPart => !/^(domain|secure|samesite|path)\b/i.test(wpPart)), 'Path=' + wpPathValue].join('; ') + '; SameSite=Lax');
    }
    return wpVisible;
  }
  function wpHeaders(wpSession, wpInput, wpRequestPath) {
    const wpResult = wpCleanHeaders(wpInput);
    const wpOrigin = `http://127.0.0.1:${wpSession.port}`;
    if (wpResult.origin) wpResult.origin = wpOrigin;
    if (wpResult.referer) {
      try { const wpRef = new URL(wpResult.referer); wpResult.referer = wpOrigin + wpRef.pathname + wpRef.search; } catch { delete wpResult.referer; }
    }
    const wpBrowserCookies = new Map();
    for (const wpPair of (wpResult.cookie || '').split(';')) {
      const wpI = wpPair.indexOf('=');
      if (wpI > 0) wpBrowserCookies.set(wpPair.slice(0, wpI).trim(), wpPair.trim());
    }
    const wpMatches = [];
    for (const [wpKey, wpCookie] of wpSession.cookies) {
      if (wpCookie.expires <= Date.now()) { wpSession.cookies.delete(wpKey); continue; }
      if (wpCookie.httpOnly) wpBrowserCookies.delete(wpCookie.name);
      const wpUrlPath = wpRequestPath.split('?')[0];
      if (wpUrlPath === wpCookie.path || (wpUrlPath.startsWith(wpCookie.path) && (wpCookie.path.endsWith('/') || wpUrlPath[wpCookie.path.length] === '/'))) wpMatches.push(wpCookie);
    }
    wpMatches.sort((wpA, wpB) => wpB.path.length - wpA.path.length);
    const wpCookiePairs = wpMatches.map(wpCookie => {
      if (!wpCookie.httpOnly && wpBrowserCookies.has(wpCookie.name)) { const wpPair = wpBrowserCookies.get(wpCookie.name); wpBrowserCookies.delete(wpCookie.name); wpCookie.pair = wpPair; return wpPair; }
      return wpCookie.pair;
    });
    wpCookiePairs.push(...wpBrowserCookies.values());
    if (wpCookiePairs.length) wpResult.cookie = wpCookiePairs.join('; '); else delete wpResult.cookie;
    return wpResult;
  }
  function wpBody(wpData, wpMax = wpLimit) {
    if (wpData === undefined || wpData === '') return Buffer.alloc(0);
    if (typeof wpData !== 'string' || wpData.length > Math.ceil(wpMax / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(wpData)) throw new Error('Invalid preview body');
    const wpBuffer = Buffer.from(wpData, 'base64');
    if (wpBuffer.length > wpMax) throw new Error('Preview body too large');
    return wpBuffer;
  }
  function wpSyncCookies(wpSession, wpArgs, wpPathValue) {
    const wpInputHeaders = wpCleanHeaders(wpArgs.headers);
    if (typeof wpArgs.cookie === 'string' && !/[\r\n\0]/.test(wpArgs.cookie)) wpInputHeaders.cookie = wpArgs.cookie;
    const wpIncoming = wpInputHeaders.cookie || '';
    const wpPairs = new Map(wpIncoming.split(';').filter(wpPair => wpPair.includes('=')).map(wpPair => [wpPair.slice(0, wpPair.indexOf('=')).trim(), wpPair.trim()]));
    const wpCookiePath = typeof wpArgs.cookiePath === 'string' && wpArgs.cookiePath.startsWith('/') ? wpArgs.cookiePath.split('?')[0] : wpPathValue.split('?')[0];
    for (const [wpKey, wpCookie] of wpSession.cookies) {
      const wpVisible = wpCookiePath === wpCookie.path || (wpCookiePath.startsWith(wpCookie.path) && (wpCookie.path.endsWith('/') || wpCookiePath[wpCookie.path.length] === '/'));
      if (wpCookie.httpOnly || !wpVisible) continue;
      if (wpPairs.has(wpCookie.name)) wpCookie.pair = wpPairs.get(wpCookie.name);
      else if (wpArgs.cookiesAuthoritative === true) wpSession.cookies.delete(wpKey);
    }
    return wpInputHeaders;
  }
  function wpHttpStream(wpSession, wpReq, wpRes, wpZlib, wpCrypto) {
    if (wpSession.streams.size >= 16) throw new Error('Too many preview streams');
    const wpId = wpCrypto.randomUUID();
    const wpHeadersValue = wpCleanHeaders(wpRes.headers, true);
    const wpDecoders = [];
    let wpSource = wpRes;
    const wpEncodings = String(wpHeadersValue['content-encoding'] || '').toLowerCase().split(',').map(wpEncoding => wpEncoding.trim()).filter(Boolean).reverse();
    for (const wpEncoding of wpEncodings) {
      if (wpEncoding === 'identity') continue;
      const wpFactory = { gzip: wpZlib.createGunzip, br: wpZlib.createBrotliDecompress, deflate: wpZlib.createInflate }[wpEncoding];
      if (!wpFactory) throw new Error('Unsupported preview response encoding');
      const wpDecoder = wpFactory();
      wpDecoders.push(wpDecoder);
      wpSource = wpSource.pipe(wpDecoder);
    }
    delete wpHeadersValue['content-encoding'];
    let wpDone = false, wpErrorText = '', wpBytes = 0, wpWaiter = null, wpIdleTimer;
    const wpChunks = [];
    function wpTouch() {
      clearTimeout(wpIdleTimer);
      wpIdleTimer = setTimeout(() => { wpDestroy('Preview stream expired'); wpSession.streams.delete(wpId); }, 60000);
      wpIdleTimer.unref?.();
    }
    function wpTake() {
      const wpValue = { chunks: wpChunks.splice(0), done: wpDone, ...(wpErrorText ? { error: wpErrorText } : {}) };
      wpBytes = 0;
      if (!wpDone) wpSource.resume();
      else { clearTimeout(wpIdleTimer); wpSession.streams.delete(wpId); }
      return wpValue;
    }
    function wpFlush() {
      if (wpWaiter && (wpChunks.length || wpDone)) {
        const wpResolvePoll = wpWaiter; wpWaiter = null; wpResolvePoll(wpTake());
      }
    }
    function wpFinish(wpError) { if (wpDone) return; wpDone = true; wpErrorText = wpError || ''; wpFlush(); }
    function wpDestroy(wpError) { wpFinish(wpError); wpReq.destroy(); for (const wpDecoder of wpDecoders) wpDecoder.destroy(); }
    wpSource.on('data', wpChunk => {
      if (wpDone) return;
      wpBytes += wpChunk.length;
      if (wpBytes > wpLimit) { wpDestroy('Preview stream buffer exceeded'); return; }
      wpChunks.push(wpChunk.toString('base64'));
      // Pausing the final decoder also backpressures the HTTP socket; a slow
      // browser never makes the Runner accumulate an unbounded SSE response.
      if (wpBytes >= 1024 * 1024 || wpChunks.length >= 256) wpSource.pause();
      wpFlush();
    });
    wpSource.on('end', () => wpFinish());
    wpSource.on('error', () => wpDestroy('Preview stream failed'));
    wpRes.on('aborted', () => wpDestroy('Preview stream disconnected'));
    wpRes.on('error', () => wpDestroy('Preview stream failed'));
    wpReq.on('error', () => wpDestroy('Preview stream failed'));
    for (const wpDecoder of wpDecoders) wpDecoder.on('error', () => wpDestroy('Preview stream decoding failed'));
    const wpStream = {
      headers: wpHeadersValue,
      destroy() { wpDestroy(); },
      poll(wpSignal) {
        if (wpSignal?.aborted) throw new Error('Preview request aborted');
        if (wpWaiter) throw new Error('Preview stream poll already pending');
        wpTouch();
        if (wpChunks.length || wpDone) return Promise.resolve(wpTake());
        return new Promise(wpResolvePoll => {
          const wpComplete = wpValue => { clearTimeout(wpPollTimer); wpSignal?.removeEventListener('abort', wpAbortPoll); wpWaiter = null; wpResolvePoll(wpValue); };
          const wpAbortPoll = () => wpComplete({ chunks: [], done: false });
          const wpPollTimer = setTimeout(() => wpComplete({ chunks: [], done: false }), 15000); wpPollTimer.unref?.();
          wpSignal?.addEventListener('abort', wpAbortPoll, { once: true });
          wpWaiter = wpComplete;
        });
      },
    };
    wpSession.streams.set(wpId, wpStream); wpTouch();
    return { stream: wpId, headers: Object.entries(wpHeadersValue) };
  }
  async function wpHttp(wpSession, wpArgs, wpSignal) {
    const wpPathValue = wpPath(wpArgs.path, wpSession.port);
    const wpMethod = String(wpArgs.method || 'GET').toUpperCase();
    if (!/^[A-Z]+$/.test(wpMethod) || ['CONNECT', 'TRACE', 'TRACK'].includes(wpMethod)) throw new Error('Invalid preview method');
    const wpData = wpBody(wpArgs.body);
    const wpInputHeaders = wpSyncCookies(wpSession, wpArgs, wpPathValue);
    const wpHttpModule = await import('node:http');
    const wpZlib = await import('node:zlib');
    const wpCrypto = await import('node:crypto');
    if (wpClosed || wpSession.exp <= Date.now()) throw new Error('Preview session expired');
    if (wpPending.size >= 128) throw new Error('Too many preview requests');
    return new Promise((wpResolve, wpReject) => {
      let wpTimer;
      const wpReq = wpHttpModule.request({ hostname: '127.0.0.1', port: wpSession.port, path: wpPathValue, method: wpMethod, signal: wpSignal, headers: { ...wpHeaders(wpSession, wpInputHeaders, wpPathValue), ...(wpData.length ? { 'content-length': wpData.length } : {}) }, agent: false }, wpRes => {
        wpRes.on('error', wpReject);
        if (/^text\/event-stream\b/i.test(String(wpRes.headers['content-type'] || ''))) {
          clearTimeout(wpTimer);
          try {
            const wpStreamValue = wpHttpStream(wpSession, wpReq, wpRes, wpZlib, wpCrypto);
            wpResolve({ status: wpRes.statusCode, ...wpStreamValue, cookies: wpSaveCookies(wpSession, wpRes.headers, wpPathValue) });
          } catch (wpError) { wpReq.destroy(); wpReject(wpError); }
          return;
        }
        const wpChunks = []; let wpBytes = 0;
        wpRes.on('data', wpChunk => { wpBytes += wpChunk.length; if (wpBytes > wpLimit) wpReq.destroy(new Error('Preview response too large')); else wpChunks.push(wpChunk); });
        wpRes.on('error', wpReject);
        wpRes.on('end', () => {
          try {
            let wpResponseBody = Buffer.concat(wpChunks);
            const wpResponseHeaders = wpCleanHeaders(wpRes.headers, true);
            const wpEncodings = String(wpResponseHeaders['content-encoding'] || '').toLowerCase().split(',').map(wpEncoding => wpEncoding.trim()).filter(Boolean).reverse();
            for (const wpEncoding of wpEncodings) {
              if (!wpResponseBody.length || wpEncoding === 'identity') continue;
              const wpDecompress = { gzip: wpZlib.gunzipSync, br: wpZlib.brotliDecompressSync, deflate: wpZlib.inflateSync }[wpEncoding];
              if (!wpDecompress) throw new Error('Unsupported preview response encoding');
              wpResponseBody = wpDecompress(wpResponseBody, { maxOutputLength: wpLimit });
            }
            delete wpResponseHeaders['content-encoding'];
            wpResolve({ status: wpRes.statusCode, headers: Object.entries(wpResponseHeaders), body: wpResponseBody.toString('base64'), cookies: wpSaveCookies(wpSession, wpRes.headers, wpPathValue) });
          } catch (wpError) { wpReject(wpError); }
        });
      });
      wpPending.add(wpReq); wpSession.requests.add(wpReq);
      wpTimer = setTimeout(() => wpReq.destroy(Object.assign(new Error('Preview request timed out'), { code: 'PREVIEW_SERVICE_TIMEOUT' })), 30000); wpTimer.unref?.();
      wpReq.on('error', wpReject);
      wpReq.on('close', () => { clearTimeout(wpTimer); wpPending.delete(wpReq); wpSession.requests.delete(wpReq); });
      wpReq.end(wpData);
    });
  }
  async function wpOpen(wpSession, wpArgs, wpSignal) {
    const wpPathValue = wpPath(wpArgs.path, wpSession.port);
    if (wpSession.sockets.size >= 16) throw new Error('Too many preview sockets');
    const wpInputHeaders = wpSyncCookies(wpSession, wpArgs, wpPathValue);
    const wpProtocols = wpArgs.protocols || [];
    if (!Array.isArray(wpProtocols) || wpProtocols.length > 16 || wpProtocols.some(wpP => typeof wpP !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(wpP)) || new Set(wpProtocols).size !== wpProtocols.length) throw new Error('Invalid WebSocket protocols');
    const wpHttpModule = await import('node:http');
    const wpCrypto = await import('node:crypto');
    if (wpClosed || wpSession.exp <= Date.now()) throw new Error('Preview session expired');
    if (wpPending.size >= 128) throw new Error('Too many preview requests');
    const wpKey = wpCrypto.randomBytes(16).toString('base64');
    return new Promise((wpResolve, wpReject) => {
      const wpReq = wpHttpModule.request({ hostname: '127.0.0.1', port: wpSession.port, path: wpPathValue, method: 'GET', signal: wpSignal, agent: false, headers: { ...wpHeaders(wpSession, { ...wpInputHeaders, origin: 'http://localhost' }, wpPathValue), connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': wpKey, ...(wpProtocols.length ? { 'sec-websocket-protocol': wpProtocols.join(', ') } : {}) } });
      wpPending.add(wpReq); wpSession.requests.add(wpReq);
      const wpTimer = setTimeout(() => wpReq.destroy(new Error('WebSocket handshake timed out')), 10000); wpTimer.unref?.();
      const wpCleanup = () => { clearTimeout(wpTimer); wpPending.delete(wpReq); wpSession.requests.delete(wpReq); };
      wpReq.on('error', wpError => { wpCleanup(); wpReject(wpError); });
      wpReq.on('response', wpRes => { wpRes.destroy(); wpCleanup(); wpReject(new Error('WebSocket upgrade rejected')); });
      wpReq.on('upgrade', (wpRes, wpRaw, wpHead) => {
        wpCleanup();
        const wpProtocol = wpRes.headers['sec-websocket-protocol'] || '';
        if (wpClosed || wpSession.exp <= Date.now() || wpRes.statusCode !== 101 || String(wpRes.headers.upgrade).toLowerCase() !== 'websocket' || wpRes.headers['sec-websocket-accept'] !== wpCrypto.createHash('sha1').update(wpKey + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64') || wpRes.headers['sec-websocket-extensions'] || (wpProtocol && !wpProtocols.includes(wpProtocol))) { wpRaw.destroy(); wpReject(new Error('Invalid WebSocket handshake')); return; }
        wpSaveCookies(wpSession, wpRes.headers, wpPathValue);
        const wpId = wpCrypto.randomUUID();
        let wpBuffer = Buffer.alloc(0), wpFragments = [], wpFragmentBytes = 0, wpFragmentOp = 0, wpQueueBytes = 0, wpWaiter = null, wpEnded = false;
        const wpEvents = [];
        let wpIdleTimer;
        function wpTouch() { clearTimeout(wpIdleTimer); wpIdleTimer = setTimeout(() => { wpFinish(); wpRaw.destroy(); wpSession.sockets.delete(wpId); }, 60000); wpIdleTimer.unref?.(); }
        function wpFlush() { if (wpWaiter && wpEvents.length) { const wpResolvePoll = wpWaiter; wpWaiter = null; wpQueueBytes = 0; wpResolvePoll({ events: wpEvents.splice(0) }); } }
        function wpEvent(wpEventValue) {
          wpQueueBytes += wpEventValue.data?.length || 0;
          if (wpQueueBytes > wpWsLimit * 2 || wpEvents.length >= 256) { wpRaw.destroy(); return; }
          wpEvents.push(wpEventValue); wpFlush();
        }
        function wpFrame(wpOpcode, wpData) {
          if (wpRaw.destroyed || wpRaw.writableLength > wpWsLimit * 2) throw new Error('WebSocket closed or backpressured');
          const wpExtra = wpData.length < 126 ? 0 : wpData.length <= 65535 ? 2 : 8;
          const wpOut = Buffer.alloc(2 + wpExtra + 4 + wpData.length);
          wpOut[0] = 0x80 | wpOpcode; wpOut[1] = 0x80 | (wpExtra === 0 ? wpData.length : wpExtra === 2 ? 126 : 127);
          if (wpExtra === 2) wpOut.writeUInt16BE(wpData.length, 2);
          if (wpExtra === 8) wpOut.writeBigUInt64BE(BigInt(wpData.length), 2);
          const wpMask = wpCrypto.randomBytes(4); wpMask.copy(wpOut, 2 + wpExtra);
          for (let wpI = 0; wpI < wpData.length; wpI++) wpOut[6 + wpExtra + wpI] = wpData[wpI] ^ wpMask[wpI % 4];
          wpRaw.write(wpOut);
        }
        function wpFinish(wpCode = 1006, wpReason = '') { if (wpEnded) return; wpEnded = true; clearTimeout(wpIdleTimer); wpEvent({ type: 'close', code: wpCode, reason: wpReason }); }
        function wpReceive(wpChunk) {
          if (wpEnded) return;
          wpBuffer = Buffer.concat([wpBuffer, wpChunk]);
          try {
            while (wpBuffer.length >= 2) {
              const wpFinal = !!(wpBuffer[0] & 128), wpOpcode = wpBuffer[0] & 15;
              let wpLength = wpBuffer[1] & 127, wpOffset = 2;
              if ((wpBuffer[0] & 112) || (wpBuffer[1] & 128) || ![0, 1, 2, 8, 9, 10].includes(wpOpcode)) throw new Error('Invalid WebSocket frame');
              if (wpLength === 126) { if (wpBuffer.length < 4) return; wpLength = wpBuffer.readUInt16BE(2); wpOffset = 4; }
              else if (wpLength === 127) { if (wpBuffer.length < 10) return; const wpBig = wpBuffer.readBigUInt64BE(2); if (wpBig > BigInt(wpWsLimit)) throw new Error('WebSocket frame too large'); wpLength = Number(wpBig); wpOffset = 10; }
              if (wpLength > wpWsLimit || (wpOpcode >= 8 && (!wpFinal || wpLength > 125))) throw new Error('Invalid WebSocket frame size');
              if (wpBuffer.length < wpOffset + wpLength) return;
              const wpPayload = wpBuffer.subarray(wpOffset, wpOffset + wpLength); wpBuffer = wpBuffer.subarray(wpOffset + wpLength);
              if (wpOpcode === 9) { wpFrame(10, wpPayload); continue; }
              if (wpOpcode === 10) continue;
              if (wpOpcode === 8) { if (wpPayload.length === 1) throw new Error('Invalid WebSocket close'); const wpCode = wpPayload.length >= 2 ? wpPayload.readUInt16BE(0) : 1005; if (wpPayload.length >= 2 && !wpValidClose(wpCode)) throw new Error('Invalid WebSocket close code'); const wpReason = new TextDecoder('utf-8', { fatal: true }).decode(wpPayload.subarray(2)); wpFrame(8, wpPayload); wpFinish(wpCode, wpReason); wpRaw.end(); return; }
              if (wpOpcode === 0 ? !wpFragmentOp : !!wpFragmentOp) throw new Error('Invalid WebSocket fragmentation');
              if (wpOpcode !== 0) wpFragmentOp = wpOpcode;
              wpFragmentBytes += wpPayload.length;
              if (wpFragmentBytes > wpWsLimit) throw new Error('WebSocket message too large');
              wpFragments.push(wpPayload);
              if (wpFinal) { const wpMessage = Buffer.concat(wpFragments); wpEvent({ type: 'message', data: wpFragmentOp === 2 ? wpMessage.toString('base64') : new TextDecoder('utf-8', { fatal: true }).decode(wpMessage), binary: wpFragmentOp === 2 }); wpFragments = []; wpFragmentBytes = 0; wpFragmentOp = 0; }
            }
          } catch { wpEvent({ type: 'error' }); wpRaw.destroy(); }
        }
        const wpSocket = {
          destroy() { wpFinish(); wpRaw.destroy(); },
          send(wpData, wpBinary) { wpTouch(); if (wpEnded) throw new Error('WebSocket closed'); const wpPayload = wpBinary ? wpBody(wpData, wpWsLimit) : Buffer.from(String(wpData)); if (wpPayload.length > wpWsLimit) throw new Error('WebSocket message too large'); wpFrame(wpBinary ? 2 : 1, wpPayload); },
          close(wpCode, wpReason) { const wpText = Buffer.from(wpReason || ''); if (!wpValidClose(wpCode) || wpText.length > 123) throw new Error('Invalid WebSocket close'); const wpData = Buffer.alloc(2 + wpText.length); wpData.writeUInt16BE(wpCode); wpText.copy(wpData, 2); wpFrame(8, wpData); wpFinish(wpCode, wpReason || ''); wpRaw.end(); const wpKill = setTimeout(() => wpRaw.destroy(), 1000); wpKill.unref?.(); },
          poll(wpSignal) { wpTouch(); if (wpSignal?.aborted) throw new Error('Preview request aborted'); if (wpWaiter) throw new Error('WebSocket poll already pending'); if (wpEvents.length) { wpQueueBytes = 0; const wpResult = { events: wpEvents.splice(0) }; if (wpEnded) wpSession.sockets.delete(wpId); return Promise.resolve(wpResult); } if (wpEnded) { wpSession.sockets.delete(wpId); return Promise.resolve({ events: [] }); } return new Promise(wpResolvePoll => { const wpPollTimer = setTimeout(() => { wpWaiter = null; wpSignal?.removeEventListener('abort', wpAbortPoll); wpResolvePoll({ events: [] }); }, 15000); wpPollTimer.unref?.(); const wpAbortPoll = () => { clearTimeout(wpPollTimer); wpWaiter = null; wpResolvePoll({ events: [] }); }; wpSignal?.addEventListener('abort', wpAbortPoll, { once: true }); wpWaiter = wpValue => { clearTimeout(wpPollTimer); wpSignal?.removeEventListener('abort', wpAbortPoll); wpResolvePoll(wpValue); }; }); },
        };
        wpSession.sockets.set(wpId, wpSocket); wpTouch();
        wpRaw.on('data', wpReceive); wpRaw.on('error', () => { wpEvent({ type: 'error' }); wpFinish(); }); wpRaw.on('close', () => wpFinish());
        if (wpHead.length) wpReceive(wpHead);
        wpResolve({ socket: wpId, protocol: wpProtocol });
      });
      wpReq.end();
    });
  }
  function wpValidClose(wpCode) { return Number.isInteger(wpCode) && ((wpCode >= 1000 && wpCode <= 1014 && ![1004, 1005, 1006].includes(wpCode)) || (wpCode >= 3000 && wpCode <= 4999)); }
  return {
    async request(wpTask, wpOp, wpArgs, wpSignal) {
      if (wpSignal?.aborted) throw new Error('Preview request aborted');
      const wpSession = await wpAuthorize(wpTask, wpArgs?.ticket);
      if (wpOp === 'http') return wpHttp(wpSession, wpArgs, wpSignal);
      if (wpOp === 'http_poll' || wpOp === 'http_close') {
        const wpStream = wpSession.streams.get(wpArgs.stream);
        if (!wpStream) throw new Error('Unknown preview stream');
        if (wpOp === 'http_poll') return wpStream.poll(wpSignal);
        wpStream.destroy(); wpSession.streams.delete(wpArgs.stream); return {};
      }
      if (wpOp === 'ws_open') return wpOpen(wpSession, wpArgs, wpSignal);
      const wpSocket = wpSession.sockets.get(wpArgs.socket);
      if (!wpSocket) throw new Error('Unknown preview socket');
      if (wpOp === 'ws_poll') return wpSocket.poll(wpSignal);
      if (wpOp === 'ws_send') { wpSocket.send(wpArgs.data, wpArgs.binary === true); return {}; }
      if (wpOp === 'ws_close') { wpSocket.close(wpArgs.code ?? 1000, wpArgs.reason); return {}; }
      throw new Error('Unknown preview operation');
    },
    close() { wpClosed = true; for (const wpSession of wpSessions.values()) wpPrune(wpSession); for (const wpReq of wpPending) wpReq.destroy(new Error('Preview transport closed')); wpPending.clear(); },
  };
}
