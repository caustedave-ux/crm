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
  async reload() {
    return this.loadPage(1);
  },
  async loadPage(page) {
    this.setData({ loading: true, error: '' });
    try {
      const res = await api.request('GET', '/api/mp/products?kw=' + encodeURIComponent(this.data.kw) + '&page=' + page);
      const items = res.list.map(function (p) {
        return {
          id: p.id,
          name: p.name,
          nameEn: p.name_en || '',
          model: p.model || '',
          hs: p.hs_code || '',
          unit: p.unit || '',
          price: fmt.money(p.price, p.currency || 'USD'),
          stock: p.stock,
          lowStock: Number(p.stock_alert) > 0 && Number(p.stock) <= Number(p.stock_alert),
        };
      });
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
});
