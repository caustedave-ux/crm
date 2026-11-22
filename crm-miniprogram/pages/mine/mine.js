const auth = require('../../utils/auth');

Page({
  data: {
    loggedIn: false,
    userText: '',
    uidText: '',
    loading: true,
  },

  async onShow() {
    const session = await auth.currentSession();
    if (!session) {
      this.setData({ loading: false, loggedIn: false, userText: '游客', uidText: '' });
      return;
    }
    const user = session.user || {};
    const uid = String(user.id || '');
    this.setData({
      loading: false,
      loggedIn: true,
      userText: user.email || user.phone || '微信用户',
      uidText: uid ? uid.slice(0, 6) + '…' + uid.slice(-4) : '',
    });
  },

  async onLogin() {
    wx.navigateTo({ url: '/pages/login/login' });
  },

  goProducts() {
    wx.navigateTo({ url: '/pages/products/products' });
  },

  goStock() {
    wx.navigateTo({ url: '/pages/stock/stock' });
  },

  async onLogout() {
    const res = await new Promise((resolve) => {
      wx.showModal({
        title: '退出登录',
        content: '确定要退出当前账号吗？',
        success: (r) => resolve(r.confirm),
        fail: () => resolve(false),
      });
    });
    if (res) getApp().logout();
  },
});
