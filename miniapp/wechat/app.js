const api = require('./utils/api');

App({
  globalData: {
    user: null,
  },
  onLaunch() {
    const user = wx.getStorageSync('crm_user');
    if (user) this.globalData.user = user;
  },
  // 退出登录：清空本地凭据并回到登录页
  logout() {
    api.request('POST', '/api/mp/logout').catch(() => {});
    api.clearToken();
    wx.removeStorageSync('crm_user');
    this.globalData.user = null;
    wx.reLaunch({ url: '/pages/login/login' });
  },
});
