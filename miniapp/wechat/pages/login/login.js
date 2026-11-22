const api = require('../../utils/api');

Page({
  data: {
    username: '',
    password: '',
    loading: false,
    error: '',
  },
  onShow() {
    // 已登录则直接进入工作台
    if (api.getToken()) {
      wx.switchTab({ url: '/pages/dashboard/dashboard' });
    }
  },
  onInput(e) {
    const field = e.currentTarget.dataset.field;
    const patch = {};
    patch[field] = e.detail.value;
    this.setData(patch);
  },
  async onSubmit() {
    const username = (this.data.username || '').trim();
    const password = this.data.password || '';
    if (!username || !password) {
      this.setData({ error: '请输入用户名和密码' });
      return;
    }
    this.setData({ loading: true, error: '' });
    try {
      const res = await api.request('POST', '/api/mp/login', { username: username, password: password });
      api.setToken(res.token);
      wx.setStorageSync('crm_user', res.user);
      getApp().globalData.user = res.user;
      wx.switchTab({ url: '/pages/dashboard/dashboard' });
    } catch (e) {
      this.setData({ error: e.message, loading: false });
    }
  },
});
