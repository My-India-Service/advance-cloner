const express = require('express');
const nodeFetch = require('node-fetch');
const cheerio = require('cheerio');
const archiver = require('archiver');
const fs = require('fs');
const path = require('path');
const { default: PQueue } = require('p-queue');
const EventEmitter = require('events');
const { URL } = require('url');
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;
app.use(express.static(path.join(__dirname, 'public')));

// Create an event emitter for progress updates
const progressEmitter = new EventEmitter();

// Store job statuses
const crawlJobs = new Map();

// Utility functions
function normalizeUrl(base, href) {
    try {
        if (!href || !base) return null;
        href = href.trim();
        
        // Skip invalid URLs
        if (href.startsWith('data:') || 
            href.startsWith('mailto:') || 
            href.startsWith('tel:') || 
            href.startsWith('javascript:')) {
            return null;
        }
        
        // Handle hash links
        if (href.startsWith('#')) return base;
        
        // Handle relative URLs
        const baseUrl = new URL(base);
        const resolvedUrl = new URL(href, baseUrl);
        
        // Remove hash to avoid duplicate content
        resolvedUrl.hash = '';
        
        return resolvedUrl.href;
    } catch (e) {
        console.error(`Error normalizing URL: base=${base}, href=${href}`, e.message);
        return null;
    }
}

function cleanFilename(url) {
    try {
        let parsed = new URL(url);
        let file = parsed.pathname.endsWith('/') ? 'index.html' : path.basename(parsed.pathname);
        let dir = parsed.pathname.endsWith('/') ? parsed.pathname : path.dirname(parsed.pathname);
        
        // Remove query parameters and fragments
        file = file.split('?')[0].split('#')[0];
        
        // Sanitize filename
        file = file.replace(/[^a-zA-Z0-9\-_.]/g, '_');
        
        // Handle empty filenames
        if (!file || file.trim() === '') file = 'index.html';
        
        return (dir + '/' + file).replace(/\/+/g, '/').replace(/^\//, '');
    } catch (e) {
        console.error(`Error cleaning filename: ${url}`, e.message);
        return url.replace(/https?:\/\//, '')
                 .replace(/[^a-zA-Z0-9\-_.\/]/g, '_');
    }
}

function isInternal(url, rootUrl) {
    try {
        const urlHost = new URL(url).hostname;
        const rootHost = new URL(rootUrl).hostname;
        return urlHost === rootHost;
    } catch {
        return false;
    }
}

function filterAssets($, fileTypes, baseUrl) {
    let assets = [];
    
    try {
        // Always include CSS and JS files
        $('link[rel="stylesheet"][href], script[src]').each((_, el) => {
            const href = $(el).attr('href') || $(el).attr('src');
            const normalized = normalizeUrl(baseUrl, href);
            if (normalized) assets.push(normalized);
        });

        // Handle images based on file type setting
        if (fileTypes !== 'html') {
            $('img[src], source[src], video[src], iframe[src]').each((_, el) => {
                const src = $(el).attr('src');
                const normalized = normalizeUrl(baseUrl, src);
                if (normalized) assets.push(normalized);
            });
        }

        // Handle CSS background images
        $('[style]').each((_, el) => {
            const style = $(el).attr('style');
            const matches = style.match(/url\(['"]?([^'")]*)['"]?\)/g) || [];
            matches.forEach(match => {
                const urlMatch = match.match(/url\(['"]?([^'")]*)['"]?\)/);
                if (urlMatch && urlMatch[1]) {
                    const normalized = normalizeUrl(baseUrl, urlMatch[1]);
                    if (normalized) assets.push(normalized);
                }
            });
        });
    } catch (e) {
        console.error('Error filtering assets:', e);
    }

    return assets.filter(Boolean);
}

function extractLinks($, baseUrl, followExternal, rootUrl) {
    let links = [];
    
    try {
        // Extract anchor tags
        $('a[href]').each((_, el) => {
            const href = $(el).attr('href');
            if (!href || href.startsWith('javascript:') || href.startsWith('mailto:')) return;
            
            const abs = normalizeUrl(baseUrl, href);
            if (!abs) return;
            
            if (followExternal || isInternal(abs, rootUrl)) {
                links.push(abs);
            }
        });
        
        // Extract iframes
        $('iframe[src], frame[src]').each((_, el) => {
            const src = $(el).attr('src');
            if (!src) return;
            
            const abs = normalizeUrl(baseUrl, src);
            if (!abs) return;
            
            if (followExternal || isInternal(abs, rootUrl)) {
                links.push(abs);
            }
        });
    } catch (e) {
        console.error('Error extracting links:', e);
    }
    
    return links.filter(Boolean);
}

async function crawlWebsite(config, jobId) {
    console.log(`Starting crawl for ${config.url}`);
    let visited = new Set();
    let fileMap = {};
    let queue = new PQueue({ concurrency: 10 });
    let rootUrl = config.url;
    let pages = 0, files = 0, size = 0, success = 0, fail = 0;
    let startedAt = Date.now();
    let fileTree = {};
    let totalTasks = 0;
    let completedTasks = 0;

    // Progress tracking function
    function sendProgress(status, currentUrl, additionalStats = {}) {
        const progress = totalTasks > 0 ? Math.min(0.95, completedTasks / totalTasks) : 0;
        const elapsed = (Date.now() - startedAt) / 1000;
        const speed = elapsed > 0 ? Math.round(size / elapsed / 1024) : 0;
        
        const update = {
            id: jobId,
            status,
            currentUrl,
            progress,
            stats: { 
                pages, 
                files, 
                speed,
                ...additionalStats
            },
            complete: false
        };
        
        crawlJobs.set(jobId, update);
        progressEmitter.emit('progress', update);
    }

    // Initial progress update
    sendProgress('Initializing crawl', config.url);

    async function downloadAsset(assetUrl) {
        if (!assetUrl || visited.has(assetUrl)) {
            completedTasks++;
            return;
        }
        visited.add(assetUrl);
        
        try {
            sendProgress('Downloading asset', assetUrl);
            
            console.log(`Downloading asset: ${assetUrl}`);
             const res = await nodeFetch(assetUrl, {
                redirect: 'follow',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Referer': rootUrl
                }
            });
            
            if (!res.ok) throw new Error(`HTTP ${res.status} - ${res.statusText}`);
            
            const buf = await res.buffer();
            const filename = config.cleanUrls ? cleanFilename(assetUrl) : assetUrl.replace(/https?:\/\//, '');
            fileMap[filename] = buf;
            files++;
            size += buf.length;
            success++;
            
            completedTasks++;
            sendProgress('Processing assets', assetUrl);
        } catch (e) {
            console.error(`Error downloading asset ${assetUrl}: ${e.message}`);
            fail++;
            completedTasks++;
            sendProgress('Error downloading', assetUrl, { error: e.message });
        }
    }

    async function crawlPage(pageUrl, level) {
        if (!pageUrl || visited.has(pageUrl)) {
            completedTasks++;
            return;
        }
        visited.add(pageUrl);

        try {
            sendProgress('Downloading page', pageUrl);
            console.log(`Crawling page: ${pageUrl} (level ${level})`);
            // Change from fetch() to nodeFetch()
            const res = await nodeFetch(pageUrl, {
                redirect: 'follow',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Referer': rootUrl
                }
            });
            
            // Handle redirects
            let finalUrl = pageUrl;
            if (res.redirected) {
                finalUrl = res.url;
                console.log(`Redirected to: ${finalUrl}`);
                if (visited.has(finalUrl)) {
                    completedTasks++;
                    return;
                }
                visited.add(finalUrl);
            }
            
            if (!res.ok) throw new Error(`HTTP ${res.status} - ${res.statusText}`);
            
            // Check content type
            const contentType = res.headers.get('content-type') || '';
            if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
                // Treat non-HTML as asset
                console.log(`Treating as asset: ${finalUrl} (${contentType})`);
                await downloadAsset(finalUrl);
                completedTasks++;
                return;
            }
            
            const html = await res.text();
            const filename = config.cleanUrls ? cleanFilename(finalUrl) : finalUrl.replace(/https?:\/\//, '');
            fileMap[filename] = Buffer.from(html, 'utf8');
            pages++;
            size += Buffer.byteLength(html);
            success++;
            
            const $ = cheerio.load(html);
            const assets = filterAssets($, config.fileTypes, finalUrl);
            const links = extractLinks($, finalUrl, config.followExternal, rootUrl);

            console.log(`Found ${assets.length} assets and ${links.length} links on ${finalUrl}`);
            
            // Add new tasks to queue
            const newTasks = [];
            for (const assetUrl of assets) {
                if (!visited.has(assetUrl)) {
                    newTasks.push(() => downloadAsset(assetUrl));
                }
            }
            for (const link of links) {
                if (!visited.has(link) && (config.depth === 0 || level < config.depth)) {
                    newTasks.push(() => crawlPage(link, level + 1));
                }
            }
            
            // Update total tasks count
            totalTasks += newTasks.length;
            if (newTasks.length > 0) {
                queue.addAll(newTasks);
            }

            completedTasks++;
            sendProgress('Processing links', finalUrl);
        } catch (e) {
            console.error(`Error processing page ${pageUrl}: ${e.message}`);
            fail++;
            completedTasks++;
            sendProgress('Error processing', pageUrl, { error: e.message });
        }
    }

    // Start with root page
    totalTasks = 1;
    await queue.add(() => crawlPage(config.url, 1));
    
    // Wait for all tasks to complete
    await queue.onIdle();

    // Build file tree
    function setTreeNode(tree, segments, idx = 0) {
        if (!segments || segments.length === 0) return;
        
        const key = segments[idx];
        if (!key) return;
        
        if (idx === segments.length - 1) {
            tree[key] = null;
        } else {
            tree[key] = tree[key] || {};
            setTreeNode(tree[key], segments, idx + 1);
        }
    }
    
    for (const fname of Object.keys(fileMap)) {
        if (fname) {
            const segments = fname.split('/').filter(s => s);
            if (segments.length > 0) {
                setTreeNode(fileTree, segments);
            }
        }
    }

    const time = ((Date.now() - startedAt) / 1000).toFixed(2);
    const successRate = ((pages + files) > 0 ? (success / (pages + files) * 100).toFixed(1) : 0);

    console.log(`Crawl completed for ${config.url}: ${pages} pages, ${files} assets, ${successRate}% success rate`);
    
    return {
        url: config.url,
        stats: { pages, files, size, time, successRate },
        fileMap,
        fileTree,
    };
}

// SSE endpoint for specific job
app.get('/api/clone/status/:id', (req, res) => {
    const jobId = req.params.id;
    
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
    });

    // Send initial state if exists
    const job = crawlJobs.get(jobId);
    if (job) {
        res.write(`data: ${JSON.stringify(job)}\n\n`);
    }

    // Listen for progress updates
    const progressHandler = (data) => {
        if (data.id === jobId) {
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        }
    };

    progressEmitter.on('progress', progressHandler);

    // Clean up when client closes connection
    req.on('close', () => {
        progressEmitter.off('progress', progressHandler);
        res.end();
    });
});
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'code.html'));
});
app.post('/api/clone', async (req, res) => {
    try {
        const { url, depth, fileTypes, followExternal, cleanUrls } = req.body;
        const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2);
        
        console.log(`Starting new clone job: ${jobId} for ${url}`);
        
        // Validate URL
        if (!url || !url.startsWith('http')) {
            throw new Error('Invalid URL format. Must start with http:// or https://');
        }

        // Initialize job state
        const initialJobState = {
            id: jobId,
            status: 'Starting crawl...',
            progress: 0.01,
            currentUrl: url,
            stats: { pages: 0, files: 0, speed: 0 },
            complete: false
        };
        crawlJobs.set(jobId, initialJobState);

        // Immediately emit initial state
        progressEmitter.emit('progress', initialJobState);

        // Start background job
        (async () => {
            try {
                const result = await crawlWebsite(
                    { url, depth: +depth, fileTypes, followExternal, cleanUrls },
                    jobId
                );
                
                // Save ZIP to disk
                const zipPath = path.join(__dirname, 'downloads', `${jobId}.zip`);
                fs.mkdirSync(path.dirname(zipPath), { recursive: true });
                const output = fs.createWriteStream(zipPath);
                const archive = archiver('zip', { zlib: { level: 9 } });
                
                output.on('close', () => {
                    console.log(`ZIP created for ${jobId}: ${archive.pointer()} bytes`);
                    const finalResult = { 
                        ...result, 
                        id: jobId, 
                        complete: true,
                        progress: 1,
                        status: 'Complete',
                        zipPath: `/api/clone/download/${jobId}`
                    };
                    crawlJobs.set(jobId, finalResult);
                    progressEmitter.emit('progress', finalResult);
                });
                
                archive.on('error', (err) => {
                    console.error('Archive error:', err);
                    const errorState = { 
                        error: 'Failed to create ZIP: ' + err.message, 
                        id: jobId, 
                        complete: true,
                        status: 'Error',
                        progress: 0
                    };
                    crawlJobs.set(jobId, errorState);
                    progressEmitter.emit('progress', errorState);
                });
                
                archive.pipe(output);
                
                // Add files to archive
                for (const [fname, buf] of Object.entries(result.fileMap)) {
                    if (buf && buf.length > 0) {
                        archive.append(buf, { name: fname });
                    }
                }
                
                await archive.finalize();
            } catch (e) {
                console.error('Crawl error:', e);
                const errorState = { 
                    error: e.message, 
                    id: jobId, 
                    complete: true,
                    status: 'Error',
                    progress: 0
                };
                crawlJobs.set(jobId, errorState);
                progressEmitter.emit('progress', errorState);
            }
        })();

        res.json({ id: jobId });
    } catch (e) {
        console.error('API error:', e);
        res.status(400).json({ error: 'Failed to start clone: ' + e.message });
    }
});

// Download endpoint
app.get('/api/clone/download/:id', (req, res) => {
    const { id } = req.params;
    const zipPath = path.join(__dirname, 'downloads', `${id}.zip`);
    if (fs.existsSync(zipPath)) {
        console.log(`Serving download for job ${id}`);
        res.download(zipPath, `website-copy-${id}.zip`, (err) => {
            if (err) {
                console.error('Download error:', err);
                res.status(500).send('Download failed');
            } else {
                // Clean up after download
                setTimeout(() => {
                    try {
                        fs.unlinkSync(zipPath);
                        console.log(`Cleaned up ZIP for job ${id}`);
                    } catch (e) {
                        console.error('Error deleting zip:', e);
                    }
                }, 30000); // Delete after 30 seconds
            }
        });
    } else {
        console.log(`ZIP not found for job ${id}`);
        res.status(404).send('File not found. The download may have expired or failed.');
    }
});

// Create downloads directory if not exists
if (!fs.existsSync(path.join(__dirname, 'downloads'))) {
    fs.mkdirSync(path.join(__dirname, 'downloads'), { recursive: true });
}

app.listen(PORT, () => {
    console.log(`Website Copier server running on port ${PORT}`);
    console.log(`SSE progress available at /api/clone/status/:id`);
    console.log(`Downloads directory: ${path.join(__dirname, 'downloads')}`);
});