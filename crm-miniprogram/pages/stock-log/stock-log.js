const api = require('../../utils/api');
const auth = require('../../utils/auth');

Page({
  data: {
    loading: true,
    loadingMore: false,
    errMsg: '',
    productId: 0,
    list: [],
    total: 0,
    page: 1,
    hasMore: false,
  },

  onLoad(options) {
    const productId = Number(options.productId || 0) || 0;
    this.setData({ productId });
    wx.setNavigationBarTitle({ title: productId ? '产品库存流水' : '库存流水' });
    this.load(true);
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
      const res = await api.listStockMovements({ productId: this.data.productId, page });
      const list = reset ? res.list : this.data.list.concat(res.list);
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
        errMsg: (e && e.message) || '流水加载失败',
      });
    }
  },
});
