const api = require('../../utils/api');
const { BASE_URL } = require('../../utils/config');

Page({
  data: {
    user: null,
    baseUrl: BASE_URL,
  },
  onShow() {
    if (!api.getToken()) {
      wx.reLaunch({ url: '/pages/login/login' });
      return;
    }
    this.setData({
      user: getApp().globalData.user || wx.getStorageSync('crm_user') || null,
    });
  },
  copyUrl() {
    wx.setClipboardData({ data: this.data.baseUrl });
  },
  onLogout() {
    wx.showModal({
      title: '退出登录',
      content: '确定要退出当前账号吗？',
      success: (res) => {
        if (res.confirm) getApp().logout();
      },
    });
  },
});
