'use strict';
// ============ 产品图片：云端存储 + 签名访问 ============
// 图片存在云端 runtime 桶的 shared/<uid>/products/ 下，团队成员都能读。
// 存储不提供公开 URL，展示前必须先换取签名 URL（有效期最长 1 小时）。
const { cloud } = require('./cloud');

const MAX_IMAGES = 6;
const SIGN_TTL = 3600;

function parseImages(raw) {
  try {
    const a = JSON.parse(raw || '[]');
    return Array.isArray(a) ? a.filter((x) => typeof x === 'string' && x) : [];
  } catch (e) {
    return [];
  }
}

function guessExt(file) {
  const s = String(file || '').toLowerCase();
  if (s.indexOf('.png') >= 0) return { ext: '.png', mime: 'image/png' };
  if (s.indexOf('.gif') >= 0) return { ext: '.gif', mime: 'image/gif' };
  if (s.indexOf('.webp') >= 0) return { ext: '.webp', mime: 'image/webp' };
  return { ext: '.jpg', mime: 'image/jpeg' };
}

// 微信临时文件 -> ArrayBuffer
function readTempFile(filePath) {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath,
      success: (res) => resolve(res.data),
      fail: (err) => reject(new Error((err && err.errMsg) || '读取图片失败')),
    });
  });
}

// 上传若干张图，返回云端对象路径数组
async function uploadImages(tempFiles, uid) {
  const paths = [];
  for (let i = 0; i < tempFiles.length; i += 1) {
    const tmp = tempFiles[i];
    const info = guessExt(tmp);
    const key = 'products/' + Date.now() + '_' + i + '_' + Math.random().toString(36).slice(2, 8) + info.ext;
    const path = cloud.storage.sharedPath(uid, key);
    const body = await readTempFile(tmp);
    const { error } = await cloud.storage.upload(path, body, {
      contentType: info.mime,
      cacheControl: '3600',
      upsert: false,
    });
    if (error) throw new Error((error && error.message) || '图片上传失败');
    paths.push(path);
  }
  return paths;
}

// 批量换取签名 URL，返回 { path: signedUrl }
async function signUrls(paths, ttl) {
  const list = (paths || []).filter(Boolean);
  if (!list.length) return {};
  const { data, error } = await cloud.storage.createSignedUrls(list, ttl || SIGN_TTL);
  if (error) throw new Error((error && error.message) || '图片地址获取失败');

  const rows = Array.isArray(data) ? data : ((data && data.signedUrls) || (data && data.data) || []);
  const map = {};
  rows.forEach((r) => {
    const p = r.path || r.key || r.name;
    const url = r.signedUrl || r.signedURL || r.url;
    if (p && url) map[p] = url;
  });
  return map;
}

async function removeImages(paths) {
  const list = (paths || []).filter(Boolean);
  if (!list.length) return;
  const { error } = await cloud.storage.remove(list);
  if (error) throw new Error((error && error.message) || '图片删除失败');
}

// 给产品行补上封面图（取第一张）
async function attachCovers(rows, ttl) {
  const list = rows || [];
  const paths = [];
  list.forEach((r) => {
    const imgs = parseImages(r.images);
    r.imagePaths = imgs;
    r.imageCount = imgs.length;
    if (imgs[0] && paths.indexOf(imgs[0]) < 0) paths.push(imgs[0]);
  });
  if (!paths.length) return list;
  try {
    const map = await signUrls(paths, ttl);
    list.forEach((r) => {
      r.coverUrl = r.imagePaths && r.imagePaths[0] ? (map[r.imagePaths[0]] || '') : '';
    });
  } catch (e) {
    list.forEach((r) => { r.coverUrl = ''; });
  }
  return list;
}

module.exports = {
  MAX_IMAGES,
  SIGN_TTL,
  parseImages,
  uploadImages,
  signUrls,
  removeImages,
  attachCovers,
};
