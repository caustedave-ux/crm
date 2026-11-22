const api = require('../../utils/api');
const fmt = require('../../utils/fmt');

Page({
  data: {
    kw: '',
    list: [],
    total: 0,
    page: 1,
    hasMore: false,
    loading: false,
    error: '',
  },
  onShow() {
    if (!api.getToken()) {
      wx.reLaunch({ url: '/pages/login/login' });
      return;
    }
    this.reload();
  },
  onPullDownRefresh() {
    this.reload().then(() => wx.stopPullDownRefresh());
  },
  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) this.loadPage(this.data.page + 1);
  },
  mapItem(c) {
    return {
      id: c.id,
      company: c.company_name,
      nameEn: c.name_en || '',
      country: c.country || '',
      status: c.status || '',
      level: c.level || '',
      phone: c.phone || '',
      email: c.email || '',
    };
  },
  async reload() {
    return this.loadPage(1);
  },
  async loadPage(page) {
    this.setData({ loading: true, error: '' });
    try {
      const res = await api.request('GET', '/api/mp/customers?kw=' + encodeURIComponent(this.data.kw) + '&page=' + page);
      const items = res.list.map(this.mapItem);
      const list = page === 1 ? items : this.data.list.concat(items);
      this.setData({ list: list, total: res.total, page: page, hasMore: list.length < res.total, loading: false });
    } catch (e) {
      this.setData({ error: e.message, loading: false });
    }
  },
  onSearch(e) {
    this.setData({ kw: e.detail.value });
  },
  onSearchConfirm() {
    this.reload();
  },
  goDetail(e) {
    wx.navigateTo({ url: '/pages/customer-detail/customer-detail?id=' + e.currentTarget.dataset.id });
  },
  callPhone(e) {
    const phone = e.currentTarget.dataset.phone;
    if (phone) wx.makePhoneCall({ phoneNumber: phone });
  },
});
