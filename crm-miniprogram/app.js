const { cloud } = require('./utils/cloud');

App({
  globalData: {
    user: null,
  },

  onLaunch() {
    this.restoreSession();
  },

  // 启动时恢复已有会话（刷新 token 由 SDK 自动完成）
  async restoreSession() {
    try {
      const { data: session, error } = await cloud.auth.getSession();
      if (!error && session && session.user) {
        this.globalData.user = session.user;
      } else {
        this.globalData.user = null;
      }
    } catch (e) {
      this.globalData.user = null;
    }
  },

  setUser(user) {
    this.globalData.user = user || null;
  },

  async logout() {
    try {
      await cloud.auth.signOut();
    } catch (e) {
      // 退出失败也清空本地状态
    }
    this.globalData.user = null;
    wx.switchTab({ url: '/pages/mine/mine' });
  },
});
