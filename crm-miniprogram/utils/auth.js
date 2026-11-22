'use strict';
// ============ 登录态守卫 ============
// 游客模式：未登录也能浏览共享数据（云端 anon 角色可读 is_shared 数据）。
// 写操作（新增/编辑/删除/库存调整/上传图片）前必须 requireLogin。
const { cloud } = require('./cloud');

// 返回当前会话，未登录返回 null
async function currentSession() {
  const { data: session, error } = await cloud.auth.getSession();
  if (error || !session) return null;
  return session;
}

// 页面加载时调用：返回会话（可能为 null），不做跳转，游客可继续浏览
async function guardSession() {
  return currentSession();
}

// 写操作前调用：未登录弹窗引导去登录页；返回会话或 null
async function requireLogin() {
  const session = await currentSession();
  if (session) return session;
  const go = await new Promise((resolve) => {
    wx.showModal({
      title: '需要登录',
      content: '该操作需要登录后才能使用，是否现在登录？',
      confirmText: '去登录',
      success: (r) => resolve(!!r.confirm),
    });
  });
  if (go) wx.navigateTo({ url: '/pages/login/login' });
  return null;
}

module.exports = { currentSession, guardSession, requireLogin };
