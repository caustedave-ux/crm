const api = require('../../utils/api');
const auth = require('../../utils/auth');
const fmt = require('../../utils/format');

Page({
  data: {
    loading: true,
    loadingMore: false,
    errMsg: '',
    kw: '',
    list: [],
    total: 0,
    page: 1,
    hasMore: false,
  },

  onLoad() {
    this.load(true);
  },

  // 供新增/编辑页返回时刷新
  refresh() {
    return this.load(true);
  },

  async onAdd() {
    const session = await auth.requireLogin();
    if (!session) return;
    wx.navigateTo({ url: '/pages/product-edit/product-edit' });
  },

  onStock() {
    wx.navigateTo({ url: '/pages/stock/stock' });
  },

  onDetail(e) {
    wx.navigateTo({ url: '/pages/product-detail/product-detail?id=' + e.currentTarget.dataset.id });
  },

  onPullDownRefresh() {
    this.load(true).then(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loadingMore) this.load(false);
  },

  async load(reset) {
    await auth.guardSession();
    const page = reset ? 1 : this.data.page + 1;
    if (reset) this.setData({ loading: true, errMsg: '' });
    else this.setData({ loadingMore: true });

    try {
      const res = await api.listProducts({ kw: this.data.kw, page });
      const rows = (res.list || []).map((p) => Object.assign({}, p, {
        priceText: fmt.amount(p.price),
        stockLow: Number(p.stock_alert) > 0 && Number(p.stock) <= Number(p.stock_alert),
      }));
      const list = reset ? rows : this.data.list.concat(rows);
      this.setData({
        loading: false,
        loadingMore: false,
        list,
        total: res.total,
        page,
        hasMore: list.length < res.total,
      });
    } catch (e) {
      this.setData({
        loading: false,
        loadingMore: false,
        errMsg: (e && e.message) || '产品列表加载失败',
      });
    }
  },

  onSearchInput(e) {
    this.setData({ kw: e.detail.value });
  },

  onSearch() {
    this.load(true);
  },

  copyValue(e) {
    const value = e.currentTarget.dataset.value;
    if (!value) return;
    wx.setClipboardData({ data: String(value) });
  },
});
