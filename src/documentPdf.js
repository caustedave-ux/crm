'use strict';
// ============ 单据 PDF：复用当前单据模板，生成单页 A4 PDF ============
// 使用 Apache-2.0 的 puppeteer-core，只调用本机已安装的 Chrome/Edge，不额外下载浏览器。
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const docx = require('./documents');

const MM_TO_PX = 96 / 25.4;
const PAGE_MARGIN_MM = 8;
const CONTENT_WIDTH_PX = Math.floor((210 - PAGE_MARGIN_MM * 2) * MM_TO_PX);
const CONTENT_HEIGHT_PX = Math.floor((297 - PAGE_MARGIN_MM * 2) * MM_TO_PX);

function browserCandidates() {
  const env = process.env;
  const list = [
    env.CRM_CHROME_PATH,
    env.PROGRAMFILES && path.join(env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    env['PROGRAMFILES(X86)'] && path.join(env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    env.PROGRAMFILES && path.join(env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    env['PROGRAMFILES(X86)'] && path.join(env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ];
  return list.filter(Boolean);
}

function findBrowser() {
  const hit = browserCandidates().find(p => {
    try { return fs.existsSync(p) && fs.statSync(p).isFile(); } catch (e) { return false; }
  });
  if (!hit) {
    throw new Error('未找到 Chrome/Edge。请安装 Chrome，或设置环境变量 CRM_CHROME_PATH 指向浏览器程序。');
  }
  return hit;
}

function pdfBaseUrl() {
  if (process.env.CRM_PDF_BASE_URL) return String(process.env.CRM_PDF_BASE_URL).replace(/\/+$/, '');
  return 'http://127.0.0.1:' + (process.env.PORT || '5000');
}

function safeFilename(docNo) {
  const base = String(docNo || 'document').replace(/[\\/:*?"<>|]/g, '_').trim() || 'document';
  return base + '.pdf';
}

function waitForImages(page) {
  return page.evaluate(async () => {
    await Promise.all(Array.from(document.images).map(img => {
      if (img.complete) return Promise.resolve();
      return new Promise(resolve => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
        setTimeout(resolve, 8000);
      });
    }));
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
  });
}

function fitPaperToOnePage(page) {
  return page.evaluate(({ contentWidth, contentHeight }) => {
    const paper = document.getElementById('printPaper');
    if (!paper) throw new Error('单据内容没有生成');

    // print.css 默认按自然高度分页；这里改成 A4 可打印区域，并把整张单据缩放到一页。
    paper.style.setProperty('width', contentWidth + 'px', 'important');
    paper.style.setProperty('min-width', '0', 'important');
    paper.style.setProperty('max-width', 'none', 'important');
    paper.style.setProperty('margin', '0', 'important');
    paper.style.setProperty('padding', '0', 'important');
    paper.style.setProperty('box-shadow', 'none', 'important');
    paper.style.setProperty('transform-origin', 'top left', 'important');
    paper.style.zoom = '1';
    document.body.style.setProperty('margin', '0', 'important');
    document.body.style.setProperty('padding', '0', 'important');
    document.body.style.setProperty('background', '#fff', 'important');

    // scrollWidth 能捕获表格横向溢出；scrollHeight 捕获整张单据的真实高度。
    const width = Math.max(paper.scrollWidth, paper.getBoundingClientRect().width, 1);
    const height = Math.max(paper.scrollHeight, paper.getBoundingClientRect().height, 1);
    const zoom = Math.min(1, contentWidth / width, contentHeight / height);
    if (zoom < 0.999) paper.style.zoom = String(Math.max(0.25, zoom));
    return { width, height, zoom };
  }, { contentWidth: CONTENT_WIDTH_PX, contentHeight: CONTENT_HEIGHT_PX });
}

/**
 * 根据已保存单据实时渲染 PDF。返回 Buffer，不写入临时文件。
 * 调用方必须保证 documentRow 已通过当前账号权限校验。
 */
async function generateDocumentPdf(documentRow) {
  if (!documentRow) throw new Error('单据不存在');
  const items = Array.isArray(documentRow.items) ? documentRow.items : docx.itemsFromDoc(documentRow);
  const contentHtml = docx.renderDocument(documentRow, items);
  const baseUrl = pdfBaseUrl();
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <base href="${baseUrl}/">
  <link rel="stylesheet" href="/static/vendor/bootstrap/css/bootstrap.min.css">
  <link rel="stylesheet" href="/static/vendor/bootstrap-icons/bootstrap-icons.min.css">
  <link rel="stylesheet" href="/static/css/print.css">
  <style>
    html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
    .print-toolbar, .no-print { display: none !important; }
    #printPaper { display: block !important; }
    img { max-width: 100%; }
    @page { size: A4 portrait; margin: ${PAGE_MARGIN_MM}mm; }
  </style>
</head>
<body class="print-body">
  <div class="paper" id="printPaper">${contentHtml}</div>
</body>
</html>`;

  const executablePath = findBrowser();
  let browser = null;
  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-proxy-server'],
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);
    await page.setViewport({ width: CONTENT_WIDTH_PX, height: CONTENT_HEIGHT_PX, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
    await page.emulateMediaType('print');
    await waitForImages(page);
    const fit = await fitPaperToOnePage(page);
    if (fit.zoom < 0.25) throw new Error('单据内容过多，无法缩放到一页 A4，请精简明细或备注图片');

    const output = await page.pdf({
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      pageRanges: '1',
      displayHeaderFooter: false,
    });
    const pdf = Buffer.from(output);
    if (pdf.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('浏览器没有生成有效的 PDF');
    return pdf;
  } finally {
    if (browser) {
      try { await browser.close(); } catch (e) {}
    }
  }
}

async function generateImage(html, selector) {
  const baseUrl = pdfBaseUrl();
  const completeHtml = String(html || '').replace('<head>', '<head><base href="' + baseUrl + '/">');
  let browser = null;
  try {
    browser = await puppeteer.launch({
      executablePath: findBrowser(),
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-proxy-server'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 1000, deviceScaleFactor: 2 });
    await page.setRequestInterception(true);
    page.on('request', request => {
      let allowed = request.url() === 'about:blank';
      try { allowed = allowed || new URL(request.url()).origin === baseUrl; } catch (error) {}
      if (allowed) request.continue().catch(() => {});
      else request.abort('blockedbyclient').catch(() => {});
    });
    await page.setContent(completeHtml, { waitUntil: 'networkidle0', timeout: 30000 });
    await page.evaluate(async () => { if (document.fonts && document.fonts.ready) await document.fonts.ready; });
    await waitForImages(page);
    const element = await page.$(selector);
    if (!element) throw new Error('没有找到可导出的单据内容');
    const dimensions = await element.evaluate(node => ({ width: node.scrollWidth, height: node.scrollHeight }));
    if (dimensions.width > 6000 || dimensions.height > 16000) throw new Error('图片尺寸超过限制，请拆分明细后再导出');
    const image = Buffer.from(await element.screenshot({ type: 'png', captureBeyondViewport: true }));
    if (image.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('图片生成失败');
    return image;
  } finally {
    if (browser) {
      try { await browser.close(); } catch (error) {}
    }
  }
}

async function generateDocumentImage(documentRow) {
  if (!documentRow) throw new Error('单据不存在');
  const items = Array.isArray(documentRow.items) ? documentRow.items : docx.itemsFromDoc(documentRow);
  const contentHtml = docx.renderDocument(documentRow, items);
  const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<link rel="stylesheet" href="/static/vendor/bootstrap/css/bootstrap.min.css">' +
    '<link rel="stylesheet" href="/static/vendor/bootstrap-icons/bootstrap-icons.min.css">' +
    '<link rel="stylesheet" href="/static/css/print.css">' +
    '<style>html,body{margin:0!important;padding:24px!important;background:#eef0f4!important}' +
    '.paper{width:1080px!important;min-width:0!important;max-width:none!important;box-sizing:border-box!important;' +
    'margin:0 auto!important;padding:42px!important;background:#fff!important;box-shadow:0 2px 10px rgba(15,23,42,.12)!important}</style>' +
    '</head><body class="print-body"><div class="paper" id="imagePaper">' + contentHtml + '</div></body></html>';
  return generateImage(html, '#imagePaper');
}

function safeImageFilename(value) {
  const base = String(value || 'document').replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, '_').trim() || 'document';
  return base + '.png';
}

module.exports = { generateDocumentPdf, generateDocumentImage, generateImage, findBrowser, safeFilename, safeImageFilename };
