const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const archiver = require('archiver');
const SSE = require('express-sse');
const fs = require('fs');
const path = require('path');
const PQueue = require('p-queue');

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;
app.use(express.static(path.join(__dirname, 'public'))); // Serve HTML/CSS/JS

const crawlJobs = new Map(); // { id: { ...status } }
const sse = new SSE();

// Send SSE keep-alive every 15 seconds to all clients
setInterval(() => {
    // Send a keep-alive for each active job
    for (const [jobId, job] of crawlJobs.entries()) {
        if (!job.complete) {
            sse.send({
                id: jobId,
                status: 'Initializing...',
                progress: job.progress || 0,
                currentUrl: job.currentUrl || '',
                stats: job.stats || { pages: 0, files: 0, speed: 0 },
                type: 'keep-alive',
                timestamp: Date.now(),
                complete: false
            });
        }
    }
}, 15000);

// Utility: normalize and resolve URLs, clean filenames, etc.
function normalizeUrl(base, href) {
    try {
        return new URL(href, base).href;
    } catch {
        return null;
    }
}
function cleanFilename(url) {
    let parsed = new URL(url);
    let file = parsed.pathname.endsWith('/') ? 'index.html' : path.basename(parsed.pathname);
    let dir = parsed.pathname.endsWith('/') ? parsed.pathname : path.dirname(parsed.pathname);
    return (dir + '/' + file).replace(/\/+/g, '/').replace(/^\//, '');
}
function isInternal(url, rootUrl) {
    return new URL(url).hostname === new URL(rootUrl).hostname;
}
function filterAssets($, fileTypes, baseUrl) {
    let assets = [];
    if (fileTypes === 'html' || fileTypes === 'all' || fileTypes === 'custom') {
        $('link[rel="stylesheet"], script[src], img[src], source[src], video[src]').each((_, el) => {
            let attr = el.name === 'link' ? 'href' : 'src';
            let href = $(el).attr(attr);
            if (href) assets.push(normalizeUrl(baseUrl, href));
        });
    }
    if (fileTypes === 'images') {
        $('img[src], source[src], video[src]').each((_, el) => {
            let href = $(el).attr('src');
            if (href) assets.push(normalizeUrl(baseUrl, href));
        });
    }
    return assets.filter(Boolean);
}
function extractLinks($, baseUrl, followExternal, rootUrl) {
    let links = [];
    $('a[href]').each((_, el) => {
        let href = $ (el).attr('href');
        let abs = normalizeUrl(baseUrl, href);
        if (!abs) return;
        if (followExternal || isInternal(abs, rootUrl)) links.push(abs);
    });
    return links.filter(Boolean);
}

// The website copier main logic
async function crawlWebsite({ url, depth, fileTypes, followExternal, cleanUrls }, jobId, sendProgress) {
    let visited = new Set();
    let fileMap = {}; // { filename: Buffer }
    let queue = new PQueue({ concurrency: 5 });
    let rootUrl = url;
    let pages = 0, files = 0, size = 0, success = 0, fail = 0;
    let startedAt = Date.now();
    let fileTree = {};

    async function downloadAsset(assetUrl) {
        if (!assetUrl || visited.has(assetUrl)) return;
        visited.add(assetUrl);
        try {
            let res = await fetch(assetUrl, { redirect: 'follow' });
            if (!res.ok) throw new Error('Failed');
            let buf = await res.buffer();
            let filename = cleanUrls ? cleanFilename(assetUrl) : assetUrl.replace(/https?:\/\//, '');
            fileMap[filename] = buf;
            files++;
            size += buf.length;
        } catch (e) {
            fail++;
        }
    }

    async function crawlPage(pageUrl, level) {
        if (!pageUrl || visited.has(pageUrl) || (depth > 0 && level > depth)) return;
        visited.add(pageUrl);

        try {
            let res = await fetch(pageUrl, { redirect: 'follow' });
            if (!res.ok) throw new Error('Failed');
            let html = await res.text();
            let filename = cleanUrls ? cleanFilename(pageUrl) : pageUrl.replace(/https?:\/\//, '');
            fileMap[filename] = Buffer.from(html, 'utf8');
            pages++;
            size += Buffer.byteLength(html);

            // Parse and queue assets/links
            let $ = cheerio.load(html);
            let assets = filterAssets($, fileTypes, pageUrl);
            let links = extractLinks($, pageUrl, followExternal, rootUrl);

            // Queue assets
            for (let assetUrl of assets) {
                queue.add(() => downloadAsset(assetUrl));
            }
            // Queue internal links
            for (let link of links) {
                queue.add(() => crawlPage(link, level + 1));
            }

            if (sendProgress) {
                sendProgress({
                    progress: Math.min((pages + files) / 200, 1.0),
                    status: 'Downloading',
                    currentUrl: pageUrl,
                    stats: { pages, files, speed: Math.round(size / 1024) },
                });
            }
        } catch (e) {
            fail++;
        }
    }

    await queue.add(() => crawlPage(url, 1));
    await queue.onIdle();

    // Build fileTree
    function setTreeNode(tree, segments, idx = 0) {
        const key = segments[idx];
        if (idx === segments.length - 1) {
            tree[key] = null;
        } else {
            tree[key] = tree[key] || {};
            setTreeNode(tree[key], segments, idx + 1);
        }
    }
    for (const fname of Object.keys(fileMap)) {
        setTreeNode(fileTree, fname.split('/'));
    }

    let time = ((Date.now() - startedAt) / 1000).toFixed(2);
    let successRate = ((pages + files - fail) / (pages + files) * 100).toFixed(1);

    return {
        url,
        stats: { pages, files, size, time, successRate },
        fileMap,
        fileTree,
    };
}

// Serve your form HTML
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/code.html'));
});
// Start the clone
app.post('/api/clone', async (req, res) => {
    try {
        const { url, depth, fileTypes, followExternal, cleanUrls } = req.body;
        const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2);
        crawlJobs.set(jobId, { status: 'pending', progress: 0 });

        // Immediately send initializing progress event
        sse.send({
            id: jobId,
            status: 'Initializing...',
            progress: 0,
            currentUrl: url,
            stats: { pages: 0, files: 0, speed: 0 },
            complete: false
        });

        // Start crawl in background
        (async () => {
            try {
                function sendProgress(update) {
                    crawlJobs.set(jobId, { ...update, id: jobId });
                    sse.send({ ...update, id: jobId, complete: false });
                }
                let result = await crawlWebsite(
                    { url, depth: +depth, fileTypes, followExternal, cleanUrls },
                    jobId,
                    sendProgress
                );
                // Save ZIP to disk for demo (prod: use memory or temp storage)
                const zipPath = path.join(__dirname, 'downloads', `${jobId}.zip`);
                fs.mkdirSync(path.dirname(zipPath), { recursive: true });
                const output = fs.createWriteStream(zipPath);
                const archive = archiver('zip', { zlib: { level: 9 } });
                archive.pipe(output);
                for (const [fname, buf] of Object.entries(result.fileMap)) {
                    archive.append(buf, { name: fname });
                }
                await archive.finalize();

                crawlJobs.set(jobId, { ...result, id: jobId, complete: true });
                sse.send({ ...result, id: jobId, complete: true });
            } catch (e) {
                crawlJobs.set(jobId, { error: e.message, complete: true, id: jobId });
                sse.send({ error: e.message, id: jobId, complete: true });
            }
        })();

        res.json({ id: jobId });
    } catch (e) {
        res.status(500).json({ error: 'Failed to start clone: ' + e.message });
    }
});

// SSE endpoint for progress
app.get('/api/clone/status', sse.init);

// Download endpoint
app.get('/api/clone/download/:id', (req, res) => {
    const { id } = req.params;
    const zipPath = path.join(__dirname, 'downloads', `${id}.zip`);
    if (fs.existsSync(zipPath)) {
        res.download(zipPath, `website-copy-${id}.zip`);
    } else {
        res.status(404).send('Not found');
    }
});

app.listen(PORT, () => {
    console.log('Website Copier server running on port', PORT);
});