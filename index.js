const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const Koa = require('koa');
const bodyParser = require('koa-bodyparser');
const app = new Koa();
app.use(bodyParser());
const jsesc = require('jsesc');

const headersToRemove = [
    "host", "user-agent", "accept", "accept-encoding", "content-length",
    "forwarded", "x-forwarded-proto", "x-forwarded-for", "x-cloud-trace-context"
];
const responseHeadersToRemove = ["Accept-Ranges", "Content-Length", "Keep-Alive", "Connection", "content-encoding", "set-cookie"];

// Increase the performance
const browser_args = [
  '--autoplay-policy=user-gesture-required',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-breakpad',
  '--disable-client-side-phishing-detection',
  '--disable-component-update',
  '--disable-default-apps',
  '--disable-dev-shm-usage',
  '--disable-domain-reliability',
  '--disable-extensions',
  '--disable-features=AudioServiceOutOfProcess',
  '--disable-hang-monitor',
  '--disable-ipc-flooding-protection',
  '--disable-notifications',
  '--disable-offer-store-unmasked-wallet-cards',
  '--disable-popup-blocking',
  '--disable-print-preview',
  '--disable-prompt-on-repost',
  '--disable-renderer-backgrounding',
  '--disable-speech-api',
  '--disable-sync',
  '--hide-scrollbars',
  '--disable-gpu'
  '--metrics-recording-only',
  '--mute-audio',
  '--no-default-browser-check',
  '--no-first-run',
  '--no-pings',
  '--no-zygote',
  '--password-store=basic',
  '--use-mock-keychain',
];
(async () => {
    let options = {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox',...browser_args]
    };
    if (process.env.PUPPETEER_SKIP_CHROMIUM_DOWNLOAD)
        options.executablePath = '/usr/bin/chromium-browser';
    if (process.env.PUPPETEER_HEADFUL)
        options.headless = false;
    if (process.env.PUPPETEER_PROXY)
        options.args.push(`--proxy-server=${process.env.PUPPETEER_PROXY}`);
    const browser = await puppeteer.launch(options);
    app.use(async ctx => {
        if (ctx.query.url) {
            const url = ctx.url.replace("/?url=", "");
            let responseBody;
            let responseData;
            let responseHeaders;
            const page = await browser.newPage();
            if (ctx.method == "POST") {
                await page.removeAllListeners('request');
                await page.setRequestInterception(true);
                page.on('request', interceptedRequest => {
                    var data = {
                        'method': 'POST',
                        'postData': ctx.request.rawBody
                    };
                    interceptedRequest.continue(data);
                });
            }
            const client = await page.target().createCDPSession();
            await client.send('Network.setRequestInterception', {
                patterns: [{
                    urlPattern: '*',
                    resourceType: 'Document',
                    interceptionStage: 'HeadersReceived'
                }],
            });

            await client.on('Network.requestIntercepted', async e => {
                let obj = { interceptionId: e.interceptionId };
                if (e.isDownload) {
                    await client.send('Network.getResponseBodyForInterception', {
                        interceptionId: e.interceptionId
                    }).then((result) => {
                        if (result.base64Encoded) {
                            responseData = Buffer.from(result.body, 'base64');
                        }
                    });
                    obj['errorReason'] = 'BlockedByClient';
                    responseHeaders = e.responseHeaders;
                }
                await client.send('Network.continueInterceptedRequest', obj);
                if (e.isDownload)
                    await page.close();
            });
            let headers = ctx.headers;
            headersToRemove.forEach(header => {
                delete headers[header];
            });
            await page.setExtraHTTPHeaders(headers);
            try {
                let response;
                let tryCount = 0;
                response = await page.goto(url, { timeout: 30000, waitUntil: 'domcontentloaded' });
                responseBody = await response.text();
                responseData = await response.buffer();
                while (responseBody.includes("cf-browser-verification") && tryCount <= 10) {
                    newResponse = await page.waitForNavigation({ timeout: 30000, waitUntil: 'domcontentloaded' });
                    if (newResponse) response = newResponse;
                    responseBody = await response.text();
                    responseData = await response.buffer();
                    tryCount++;
                }
                responseHeaders = await response.headers();
                const cookies = await page.cookies();
                if (cookies)
                    cookies.forEach(cookie => {
                        const { name, value, secure, expires, domain, ...options } = cookie;
                        ctx.cookies.set(cookie.name, cookie.value, options);
                    });
            } catch (error) {
                if (!error.toString().includes("ERR_BLOCKED_BY_CLIENT")) {
                    ctx.status = 500;
                    ctx.body = error;
                }
            }

            await page.close();
            responseHeadersToRemove.forEach(header => delete responseHeaders[header]);
            Object.keys(responseHeaders).forEach(header => ctx.set(header, jsesc(responseHeaders[header])));
            ctx.body = responseData;
        }
        else {
            ctx.body = "Please specify the URL in the 'url' query string.";
        }
    });
    app.listen(process.env.PORT || 3000);
})();
