const { cloud } = require('../../utils/cloud');
const auth = require('../../utils/auth');

Page({
  data: {
    loading: false,
    errMsg: '',
  },

  async onLoad() {
    const session = await auth.currentSession();
    if (session) wx.switchTab({ url: '/pages/dashboard/dashboard' });
  },

  onBrowse() {
    wx.switchTab({ url: '/pages/dashboard/dashboard' });
  },

  async onWechatLogin() {
    if (this.data.loading) return;
    this.setData({ loading: true, errMsg: '' });

    wx.login({
      success: ({ code }) => {
        this.signIn(code);
      },
      fail: (error) => {
        console.error('[WorkBuddy Cloud] login failed', JSON.stringify({
          stage: 'wx.login',
          message: error && error.errMsg,
        }));
        this.setData({
          loading: false,
          errMsg: '微信登录不可用，请在微信客户端中打开本小程序',
        });
      },
    });
  },

  async signIn(code) {
    try {
      const appid = wx.getAccountInfoSync().miniProgram.appId;
      const { data: session, error } = await cloud.auth.signInWithWechat(code, appid);
      if (error) {
        console.error('[WorkBuddy Cloud] login failed', JSON.stringify({
          stage: 'wechat-login-handler',
          message: error.message,
        }));
        this.setData({ loading: false, errMsg: error.message || '登录失败，请重试' });
        return;
      }
      getApp().setUser(session.user);
      wx.switchTab({ url: '/pages/dashboard/dashboard' });
    } catch (e) {
      console.error('[WorkBuddy Cloud] login failed', JSON.stringify({
        stage: 'wechat-login-handler',
        message: e && e.message,
      }));
      this.setData({ loading: false, errMsg: '微信登录失败，请重试' });
    }
  },
});
